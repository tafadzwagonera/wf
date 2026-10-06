/**
 * Manual Test: repo lock releases after both a successful and a failed run
 *
 * Run: nr test:manual repo-lock-releases-on-success-and-failure.smoke.ts
 *
 * Verifies that:
 *   1. Against a repo with a staged change, the commit succeeds and no lock
 *      file remains afterward
 *   2. Against a repo with nothing staged (forces a GitError), the CLI exits
 *      non-zero and no lock file remains afterward either
 *   3. Immediately re-running the same command against the same repo is
 *      never blocked by a leftover lock from the first run
 *
 * A leaked lock on either path would permanently wedge that repo for every
 * future wf invocation until someone manually deleted the lock file.
 *
 * No AI / API keys required — --message bypasses AI commit-message generation.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { createReporter, summarise } from './support/reporter';

const DIST_MAIN = path.join(__dirname, '../../dist/main.js');

const { counts, pass, fail } = createReporter();

function makeRepo(withStagedChange: boolean): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-repo-lock-release-'));
  const git = (cmd: string) => execFileSync('git', cmd.split(' '), { cwd: dir, stdio: 'pipe' });
  git('init');
  git('config user.email test@example.com');
  git('config user.name Test');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'one\n');
  git('add .');
  git('commit -m init');
  if (withStagedChange) {
    fs.writeFileSync(path.join(dir, 'a.txt'), 'two\n');
    git('add .');
  }
  return dir;
}

function countLockFiles(wfHome: string): number {
  const lockDir = path.join(wfHome, 'state', 'locks');
  if (!fs.existsSync(lockDir)) return 0;
  return fs.readdirSync(lockDir).length;
}

function runCommit(repoPath: string, wfHome: string) {
  return spawnSync('node', [DIST_MAIN, 'issue:commit', '-k', 'WBP-1', '-m', 'test', '--repos', repoPath], { encoding: 'utf-8', env: { ...process.env, WF_HOME: wfHome } });
}

function checkSuccessCommit(result: ReturnType<typeof runCommit>, wfHome: string): void {
  if (result.status === 0) {
    pass('Successful commit exits 0');
  } else {
    fail('Expected exit 0', `${result.stdout}\n${result.stderr}`);
  }
  if (countLockFiles(wfHome) === 0) {
    pass('No lock file remains after a successful commit');
  } else {
    fail('Lock file leaked after success', String(countLockFiles(wfHome)));
  }
}

function checkFailureCommit(result: ReturnType<typeof runCommit>, wfHome: string): void {
  if (result.status === 0) {
    fail('Expected a non-zero exit code for the failure case');
  } else {
    pass('Commit against a repo with nothing staged exits non-zero');
  }
  if (countLockFiles(wfHome) === 0) {
    pass('No lock file remains after a failed commit');
  } else {
    fail('Lock file leaked after failure', String(countLockFiles(wfHome)));
  }
}

function prepareAndCheckRerun(successRepo: string, wfHome: string): void {
  fs.writeFileSync(path.join(successRepo, 'a.txt'), 'three\n');
  execFileSync('git', ['add', '.'], { cwd: successRepo });
  const rerunResult = runCommit(successRepo, wfHome);
  if (rerunResult.status === 0 && !rerunResult.stdout.includes('RepoLockError')) {
    pass('Immediate re-run against the same repo is not blocked by a leftover lock');
  } else {
    fail('Re-run was unexpectedly blocked', `${rerunResult.stdout}\n${rerunResult.stderr}`);
  }
}

async function runAndClean(): Promise<void> {
  const wfHome = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-repo-lock-release-home-'));
  const successRepo = makeRepo(true);
  const failureRepo = makeRepo(false);
  try {
    checkSuccessCommit(runCommit(successRepo, wfHome), wfHome);
    checkFailureCommit(runCommit(failureRepo, wfHome), wfHome);
    prepareAndCheckRerun(successRepo, wfHome);
  } finally {
    fs.rmSync(successRepo, { recursive: true, force: true });
    fs.rmSync(failureRepo, { recursive: true, force: true });
    fs.rmSync(wfHome, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  console.log('\n repo lock releases on success and failure\n');
  await runAndClean();
  summarise(counts);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
