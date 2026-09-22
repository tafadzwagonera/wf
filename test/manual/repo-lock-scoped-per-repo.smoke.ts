/**
 * Manual Test: repo lock is scoped per-repository, not global
 *
 * Run: nr test:manual repo-lock-scoped-per-repo.smoke.ts
 *
 * Verifies that:
 *   1. While a live process holds the lock for repo A, a real CLI invocation
 *      against unrelated repo B still succeeds and creates a commit
 *   2. Repo A's lock file is untouched by the repo B run
 *
 * No AI / API keys required — --message bypasses AI commit-message generation.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { execFileSync, spawn, spawnSync, ChildProcess } from 'node:child_process';
import { createReporter, summarise } from './support/reporter';

const DIST_MAIN = path.join(__dirname, '../../dist/main.js');

const { counts, pass, fail } = createReporter();

function makeScratchRepo(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
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

function startHolderOnRepoA(
  wfHome: string, repoA: string,
): { holder: ChildProcess; lockPathA: string; lockPayload: string } {
  const holder = spawn('sleep', ['60'], { detached: true, stdio: 'ignore' });
  const lockPathA = lockPathFor(wfHome, repoA);
  fs.mkdirSync(path.dirname(lockPathA), { recursive: true });
  const lockPayload = JSON.stringify({
    pid: holder.pid, repoDir: path.resolve(repoA), startedAt: new Date().toISOString(),
  });
  fs.writeFileSync(lockPathA, lockPayload);
  return { holder, lockPathA, lockPayload };
}

function checkRepoBSucceeds(resultB: ReturnType<typeof spawnSync>): void {
  if (resultB.status === 0) {
    pass('Repo B commit succeeds while repo A is locked');
  } else {
    fail('Repo B was unexpectedly blocked', `${resultB.stdout}\n${resultB.stderr}`);
  }
}

function checkRepoBCommit(repoB: string): void {
  const logB = execFileSync('git', ['log', '--oneline'], { cwd: repoB, encoding: 'utf-8' });
  if (logB.trim().split('\n').length === 2) {
    pass('Repo B has the new commit');
  } else {
    fail('Repo B commit was not created', logB);
  }
}

function checkRepoALockUntouched(lockPathA: string, lockPayload: string): void {
  if (fs.readFileSync(lockPathA, 'utf-8') === lockPayload) {
    pass("Repo A's lock file is untouched by the repo B run");
  } else {
    fail("Repo A's lock file was modified unexpectedly");
  }
}

function cleanupScopedTest(holder: ChildProcess, repoA: string, repoB: string, wfHome: string): void {
  if (holder?.pid) process.kill(-holder.pid, 'SIGKILL');
  fs.rmSync(repoA, { recursive: true, force: true });
  fs.rmSync(repoB, { recursive: true, force: true });
  fs.rmSync(wfHome, { recursive: true, force: true });
}

async function runAndClean(): Promise<void> {
  const repoA = makeScratchRepo('wf-repo-lock-scope-a-');
  const repoB = makeScratchRepo('wf-repo-lock-scope-b-');
  const wfHome = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-repo-lock-scope-home-'));
  const { holder, lockPathA, lockPayload } = startHolderOnRepoA(wfHome, repoA);
  try {
    const resultB = spawnSync('node', [DIST_MAIN, 'issue:commit', '-k', 'WBP-1', '-m', 'test', '--repos', repoB], { encoding: 'utf-8', env: { ...process.env, WF_HOME: wfHome } });
    checkRepoBSucceeds(resultB);
    checkRepoBCommit(repoB);
    checkRepoALockUntouched(lockPathA, lockPayload);
  } finally {
    cleanupScopedTest(holder, repoA, repoB, wfHome);
  }
}

async function main(): Promise<void> {
  console.log('\n repo lock is scoped per repository\n');
  await runAndClean();
  summarise(counts);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
