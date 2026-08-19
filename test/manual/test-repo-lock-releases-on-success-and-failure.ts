/**
 * Manual Test: repo lock releases after both a successful and a failed run
 *
 * Run: nr test:manual -- test-repo-lock-releases-on-success-and-failure
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

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync, spawnSync } from 'child_process';

const DIST_MAIN = path.join(__dirname, '../../dist/main.js');

let passed = 0;
let failed = 0;
const pass = (msg: string) => {
  console.log(`  ✓ ${msg}`);
  passed++;
};
const fail = (msg: string, detail?: string) => {
  console.error(`  ✗ ${msg}${detail ? `\n    -> ${detail}` : ''}`);
  failed++;
};

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

async function main() {
  console.log('\n repo lock releases on success and failure\n');

  const wfHome = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-repo-lock-release-home-'));
  const successRepo = makeRepo(true);
  const failureRepo = makeRepo(false);

  try {
    const successResult = spawnSync(
      'node', [DIST_MAIN, 'issue:commit', '-k', 'WBP-1', '-m', 'test', '--repos', successRepo],
      { encoding: 'utf-8', env: { ...process.env, WF_HOME: wfHome } }
    );

    if (successResult.status === 0) {
      pass('Successful commit exits 0');
    } else {
      fail('Expected exit 0', `${successResult.stdout}\n${successResult.stderr}`);
    }
    if (countLockFiles(wfHome) === 0) {
      pass('No lock file remains after a successful commit');
    } else {
      fail('Lock file leaked after success', String(countLockFiles(wfHome)));
    }

    const failureResult = spawnSync(
      'node', [DIST_MAIN, 'issue:commit', '-k', 'WBP-1', '-m', 'test', '--repos', failureRepo],
      { encoding: 'utf-8', env: { ...process.env, WF_HOME: wfHome } }
    );

    if (failureResult.status !== 0) {
      pass('Commit against a repo with nothing staged exits non-zero');
    } else {
      fail('Expected a non-zero exit code for the failure case');
    }
    if (countLockFiles(wfHome) === 0) {
      pass('No lock file remains after a failed commit');
    } else {
      fail('Lock file leaked after failure', String(countLockFiles(wfHome)));
    }

    fs.writeFileSync(path.join(successRepo, 'a.txt'), 'three\n');
    execFileSync('git', ['add', '.'], { cwd: successRepo });
    const rerunResult = spawnSync(
      'node', [DIST_MAIN, 'issue:commit', '-k', 'WBP-1', '-m', 'test', '--repos', successRepo],
      { encoding: 'utf-8', env: { ...process.env, WF_HOME: wfHome } }
    );

    if (rerunResult.status === 0 && !rerunResult.stdout.includes('RepoLockError')) {
      pass('Immediate re-run against the same repo is not blocked by a leftover lock');
    } else {
      fail('Re-run was unexpectedly blocked', `${rerunResult.stdout}\n${rerunResult.stderr}`);
    }
  } finally {
    fs.rmSync(successRepo, { recursive: true, force: true });
    fs.rmSync(failureRepo, { recursive: true, force: true });
    fs.rmSync(wfHome, { recursive: true, force: true });
  }

  console.log('\n' + '='.repeat(60));
  console.log(`Results: ${passed} passed   ${failed} failed`);
  if (failed === 0) console.log('All tests passed!');
  console.log('='.repeat(60));

  if (failed > 0) process.exit(1);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
