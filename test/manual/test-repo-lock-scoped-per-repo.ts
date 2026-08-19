/**
 * Manual Test: repo lock is scoped per-repository, not global
 *
 * Run: nr test:manual -- test-repo-lock-scoped-per-repo
 *
 * Verifies that:
 *   1. While a live process holds the lock for repo A, a real CLI invocation
 *      against unrelated repo B still succeeds and creates a commit
 *   2. Repo A's lock file is untouched by the repo B run
 *
 * No AI / API keys required — --message bypasses AI commit-message generation.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';
import { execFileSync, spawn, spawnSync, ChildProcess } from 'child_process';

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

async function main() {
  console.log('\n repo lock is scoped per repository\n');

  const repoA = makeScratchRepo('wf-repo-lock-scope-a-');
  const repoB = makeScratchRepo('wf-repo-lock-scope-b-');
  const wfHome = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-repo-lock-scope-home-'));
  let holder: ChildProcess | undefined;

  try {
    holder = spawn('sleep', ['60'], { detached: true, stdio: 'ignore' });
    const lockPathA = lockPathFor(wfHome, repoA);
    fs.mkdirSync(path.dirname(lockPathA), { recursive: true });
    const lockPayload = JSON.stringify({
      pid: holder.pid, repoDir: path.resolve(repoA), startedAt: new Date().toISOString(),
    });
    fs.writeFileSync(lockPathA, lockPayload);

    const resultB = spawnSync(
      'node', [DIST_MAIN, 'issue:commit', '-k', 'WBP-1', '-m', 'test', '--repos', repoB],
      { encoding: 'utf-8', env: { ...process.env, WF_HOME: wfHome } }
    );

    if (resultB.status === 0) {
      pass('Repo B commit succeeds while repo A is locked');
    } else {
      fail('Repo B was unexpectedly blocked', `${resultB.stdout}\n${resultB.stderr}`);
    }

    const logB = execFileSync('git', ['log', '--oneline'], { cwd: repoB, encoding: 'utf-8' });
    if (logB.trim().split('\n').length === 2) {
      pass('Repo B has the new commit');
    } else {
      fail('Repo B commit was not created', logB);
    }

    if (fs.readFileSync(lockPathA, 'utf-8') === lockPayload) {
      pass("Repo A's lock file is untouched by the repo B run");
    } else {
      fail("Repo A's lock file was modified unexpectedly");
    }
  } finally {
    if (holder?.pid) process.kill(-holder.pid, 'SIGKILL');
    fs.rmSync(repoA, { recursive: true, force: true });
    fs.rmSync(repoB, { recursive: true, force: true });
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
