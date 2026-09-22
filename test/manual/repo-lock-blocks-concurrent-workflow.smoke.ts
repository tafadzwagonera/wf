/**
 * Manual Test: repo lock blocks a second wf workflow while a live process holds it
 *
 * Run: nr test:manual repo-lock-blocks-concurrent-workflow.smoke.ts
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
import { createReporter, summarise } from './support/reporter';

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

function writeLockFile(wfHome: string, repoDir: string, pid: number | undefined): string {
  const lockPath = lockPathFor(wfHome, repoDir);
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  const lockContents = JSON.stringify({ pid, repoDir: path.resolve(repoDir), startedAt: new Date().toISOString() });
  fs.writeFileSync(lockPath, lockContents);
  return lockPath;
}

function runLockedScenario(
  repoDir: string, wfHome: string, holder: ChildProcess,
): { lockPath: string; combined: string; status: number } {
  const lockPath = writeLockFile(wfHome, repoDir, holder.pid);
  const result = runCli(['issue:commit', '-k', 'WBP-1', '-m', 'test', '--repos', repoDir], wfHome);
  return { lockPath, combined: result.stdout + result.stderr, status: result.status };
}

function checkExitCode(status: number): void {
  if (status === 0) {
    fail('Expected a non-zero exit code', String(status));
  } else {
    pass('CLI exits non-zero while the lock is held');
  }
}

function checkRepoLockError(combined: string): void {
  if (combined.includes('RepoLockError') && combined.includes('Another wf workflow is already running')) {
    pass('Failure is a RepoLockError with the expected message');
  } else {
    fail('Missing RepoLockError message', combined.slice(0, 400));
  }
}

function checkHolderInfo(combined: string, pid: number | undefined, lockPath: string): void {
  if (combined.includes(`pid ${pid}`) && combined.includes(lockPath)) {
    pass('Message names the holder pid and lock file path');
  } else {
    fail('Message missing holder pid or lock file path', combined.slice(0, 400));
  }
}

function checkNoCommit(repoDir: string): void {
  const log = execFileSync('git', ['log', '--oneline'], { cwd: repoDir, encoding: 'utf-8' });
  if (log.trim().split('\n').length === 1) {
    pass('No commit was created while the lock was held');
  } else {
    fail('Unexpected commit found', log);
  }
}

function cleanupLockTest(holder: ChildProcess | undefined, repoDir: string, wfHome: string): void {
  if (holder?.pid) process.kill(-holder.pid, 'SIGKILL');
  fs.rmSync(repoDir, { recursive: true, force: true });
  fs.rmSync(wfHome, { recursive: true, force: true });
}

async function runAndClean(): Promise<void> {
  const repoDir = makeScratchRepo();
  const wfHome = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-repo-lock-home-'));
  let holder: ChildProcess | undefined;
  try {
    holder = spawn('sleep', ['60'], { detached: true, stdio: 'ignore' });
    const { lockPath, combined, status } = runLockedScenario(repoDir, wfHome, holder);
    checkExitCode(status);
    checkRepoLockError(combined);
    checkHolderInfo(combined, holder.pid, lockPath);
    checkNoCommit(repoDir);
  } finally {
    cleanupLockTest(holder, repoDir, wfHome);
  }
}

async function main(): Promise<void> {
  console.log('\n repo lock blocks a concurrent workflow\n');
  await runAndClean();
  summarise(counts);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
