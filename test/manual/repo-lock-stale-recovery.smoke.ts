/**
 * Manual Test: repo lock auto-recovers from a lock left by a dead process
 *
 * Run: nr test:manual repo-lock-stale-recovery.smoke.ts
 *
 * Verifies that:
 *   1. A lock file whose pid is no longer running is removed before the
 *      commit runs, rather than permanently blocking future workflows
 *   2. The CLI invocation exits 0
 *   3. A real commit is created in the scratch repo
 *   4. No lock file remains under the lock directory after the run
 *
 * No AI / API keys required — --message bypasses AI commit-message generation.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { createReporter, summarise } from './support/reporter';

const DIST_MAIN = path.join(__dirname, '../../dist/main.js');

const { counts, pass, fail } = createReporter();

function makeScratchRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-repo-lock-stale-'));
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

function findDeadPid(): number {
  let candidate = 999_999;
  while (candidate > 2) {
    const result = spawnSync('kill', ['-0', String(candidate)]);
    if (result.status !== 0) return candidate;
    candidate -= 1;
  }
  throw new Error('Could not find an unused pid to simulate a dead process');
}

function writeStaleLockFile(wfHome: string, repoDir: string): string {
  const lockPath = lockPathFor(wfHome, repoDir);
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  fs.writeFileSync(
    lockPath,
    JSON.stringify({ pid: findDeadPid(), repoDir: path.resolve(repoDir), startedAt: new Date().toISOString() }),
  );
  return lockPath;
}

function checkExitZero(result: ReturnType<typeof spawnSync>): void {
  if (result.status === 0) {
    pass('CLI exits 0 despite the dead-pid lock file');
  } else {
    fail('Expected exit 0', `status=${result.status}\n${result.stdout}\n${result.stderr}`);
  }
}

function checkCommitCreated(repoDir: string): void {
  const log = execFileSync('git', ['log', '--oneline'], { cwd: repoDir, encoding: 'utf-8' });
  if (log.trim().split('\n').length === 2) {
    pass('A real commit was created');
  } else {
    fail('Expected exactly 2 commits (init + new)', log);
  }
}

function checkLockCleared(lockPath: string): void {
  if (fs.existsSync(lockPath)) {
    fail('Stale lock file was not cleared and replaced correctly');
  } else {
    pass('No lock file remains after the run');
  }
}

async function runAndClean(): Promise<void> {
  const repoDir = makeScratchRepo();
  const wfHome = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-repo-lock-stale-home-'));
  try {
    const lockPath = writeStaleLockFile(wfHome, repoDir);
    const result = spawnSync('node', [DIST_MAIN, 'issue:commit', '-k', 'WBP-1', '-m', 'test', '--repos', repoDir], { encoding: 'utf-8', env: { ...process.env, WF_HOME: wfHome } });
    checkExitZero(result);
    checkCommitCreated(repoDir);
    checkLockCleared(lockPath);
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
    fs.rmSync(wfHome, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  console.log('\n repo lock stale-lock recovery\n');
  await runAndClean();
  summarise(counts);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
