/**
 * Manual Test: repo lock blocks a second wf workflow while a live process holds it
 *
 * Run: nr test:manual -- test-repo-lock-blocks-concurrent-workflow
 *
 * Verifies that:
 *   1. A live, long-running process holding the repo lock causes a second
 *      `wf issue:commit` invocation against the same repo to fail fast
 *   2. The failure is a RepoLockError with a clear, actionable message
 *   3. The message names the holder's pid, start time, and lock file path
 *   4. No commit is created while the lock is held
 *
 * This guards against the original incident: two independent wf workflows
 * (an interactive session and a separate CLI run) racing git operations
 * against the same working tree with no coordination between them.
 *
 * No AI / API keys required — --message bypasses AI commit-message generation.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { execFileSync, spawn, ChildProcess } from 'node:child_process';
import { createReporter } from './support/reporter';

const DIST_MAIN = path.join(__dirname, '../../dist/main.js');

const { counts, pass, fail } = createReporter();

function makeScratchRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-repo-lock-'));
  const git = (cmd: string) => execFileSync('git', cmd.split(' '), { cwd: dir, stdio: 'pipe' });
  git('init');
  git('config user.email test@example.com');
  git('config user.name Test');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'one\n');
  git('add .');
  git('commit -m init');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'two\n');
  git('add .');
  return dir;
}

function lockPathFor(wfHome: string, repoDir: string): string {
  const resolved = path.resolve(repoDir);
  const key = crypto.createHash('sha256').update(resolved).digest('hex').slice(0, 16);
  return path.join(wfHome, 'state', 'locks', `${key}.lock`);
}

function runCli(args: string[], wfHome: string): { stdout: string; stderr: string; status: number } {
  try {
    const stdout = execFileSync('node', [DIST_MAIN, ...args], {
      encoding: 'utf-8', env: { ...process.env, WF_HOME: wfHome },
    });
    return { stdout, stderr: '', status: 0 };
  } catch (err: any) {
    return { stdout: err.stdout ?? '', stderr: err.stderr ?? '', status: err.status ?? 1 };
  }
}

async function main(): Promise<void> {
  console.log('\n repo lock blocks a concurrent workflow\n');

  const repoDir = makeScratchRepo();
  const wfHome = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-repo-lock-home-'));
  let holder: ChildProcess | undefined;

  try {
    holder = spawn('sleep', ['60'], { detached: true, stdio: 'ignore' });
    const lockPath = lockPathFor(wfHome, repoDir);
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    fs.writeFileSync(lockPath, JSON.stringify({
      pid: holder.pid, repoDir: path.resolve(repoDir), startedAt: new Date().toISOString(),
    }));

    const result = runCli(['issue:commit', '-k', 'WBP-1', '-m', 'test', '--repos', repoDir], wfHome);
    const combined = result.stdout + result.stderr;

    if (result.status !== 0) {
      pass('CLI exits non-zero while the lock is held');
    } else {
      fail('Expected a non-zero exit code', String(result.status));
    }

    if (combined.includes('RepoLockError') && combined.includes('Another wf workflow is already running')) {
      pass('Failure is a RepoLockError with the expected message');
    } else {
      fail('Missing RepoLockError message', combined.slice(0, 400));
    }

    if (combined.includes(`pid ${holder.pid}`) && combined.includes(lockPath)) {
      pass('Message names the holder pid and lock file path');
    } else {
      fail('Message missing holder pid or lock file path', combined.slice(0, 400));
    }

    const log = execFileSync('git', ['log', '--oneline'], { cwd: repoDir, encoding: 'utf-8' });
    if (log.trim().split('\n').length === 1) {
      pass('No commit was created while the lock was held');
    } else {
      fail('Unexpected commit found', log);
    }
  } finally {
    if (holder?.pid) process.kill(-holder.pid, 'SIGKILL');
    fs.rmSync(repoDir, { recursive: true, force: true });
    fs.rmSync(wfHome, { recursive: true, force: true });
  }

  console.log('\n' + '='.repeat(60));
  console.log(`Results: ${counts.passed} passed   ${counts.failed} failed`);
  if (counts.failed === 0) console.log('All tests passed!');
  console.log('='.repeat(60));

  if (counts.failed > 0) process.exit(1);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
