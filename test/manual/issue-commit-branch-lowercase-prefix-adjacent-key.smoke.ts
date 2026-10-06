/**
 * Manual smoke test: issue:commit does not raise a false mismatch when the
 * branch has a lowercase prefix directly adjacent to the uppercase ticket key
 *
 * Run: nr test:manual issue-commit-branch-lowercase-prefix-adjacent-key.smoke.ts
 */

import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createReporter, summarise } from './support/reporter';

const DIST_MAIN = path.join(__dirname, '../../dist/main.js');

const { counts, pass, fail } = createReporter();

interface CliResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

const runCli = (args: string, cwd: string): CliResult => {
  try {
    const stdout = execSync(`node ${DIST_MAIN} ${args}`, {
      encoding: 'utf-8', cwd, timeout: 15_000, stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { exitCode: 0, stdout, stderr: '' };
  } catch (err: any) {
    return { exitCode: err.status ?? 1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
  }
};

function setupTestRepo(tmpDir: string, git: (cmd: string) => void): void {
  fs.writeFileSync(path.join(tmpDir, 'wf.config.js'), 'module.exports = {};\n');
  git('init');
  git('config user.email "test@example.com"');
  git('config user.name "Test User"');
  fs.writeFileSync(path.join(tmpDir, 'app.ts'), 'export const x = 1;\n');
  git('add .');
  git('commit -m init');
  git('checkout -b fixWBP-4061-show-review-title');
}

function checkMatchingKeyResult(matchResult: CliResult, matchOutput: string): void {
  if (matchResult.exitCode === 0) {
    pass('matching -k WBP-4061 on branch fixWBP-4061-... exits 0 (no false mismatch)');
  } else {
    fail(
      'matching -k WBP-4061 should have succeeded — branch prefix "fix" must not be absorbed into the parsed key',
      `exit code ${matchResult.exitCode}\n${matchOutput.slice(0, 500)}`
    );
  }
  if (/does not match/i.test(matchOutput)) {
    fail('unexpected mismatch warning on a valid match', matchOutput.slice(0, 500));
  } else {
    pass('no mismatch warning printed for the adjacent-prefix branch');
  }
}

function checkMatchingKeyCommit(tmpDir: string): void {
  const matchLog = execSync('git log --oneline -1', { cwd: tmpDir, encoding: 'utf-8' });
  if (matchLog.includes('WBP-4061')) {
    pass('committed subject line is prefixed with WBP-4061');
  } else {
    fail('committed subject line missing WBP-4061 prefix', matchLog);
  }
}

function checkMatchingKey(tmpDir: string, git: (cmd: string) => void): void {
  fs.writeFileSync(path.join(tmpDir, 'app.ts'), 'export const x = 2;\n');
  git('add .');
  const matchResult = runCli('issue:commit -k WBP-4061 -m "test commit"', tmpDir);
  const matchOutput = matchResult.stdout + matchResult.stderr;
  checkMatchingKeyResult(matchResult, matchOutput);
  checkMatchingKeyCommit(tmpDir);
}

function stageMismatchedChange(tmpDir: string, git: (cmd: string) => void): void {
  fs.writeFileSync(path.join(tmpDir, 'app.ts'), 'export const x = 3;\n');
  git('add .');
}

function checkMismatchedKey(tmpDir: string, git: (cmd: string) => void): void {
  stageMismatchedChange(tmpDir, git);
  const mismatchResult = runCli('issue:commit -k WBP-9999 -m "x"', tmpDir);
  const mismatchOutput = mismatchResult.stdout + mismatchResult.stderr;
  if (mismatchResult.exitCode === 0) {
    fail('WBP-9999 should have mismatched against branch key WBP-4061', `exit code ${mismatchResult.exitCode}`);
  } else {
    pass('genuinely different key WBP-9999 still triggers the mismatch path');
  }
  if (mismatchOutput.includes('WBP-9999') && mismatchOutput.includes('WBP-4061')) {
    pass('mismatch output names both the explicit key and the branch key');
  } else {
    fail('mismatch output is missing one of the ticket keys', mismatchOutput.slice(0, 500));
  }
}

function main(): void {
  console.log('\nManual smoke test: issue:commit — lowercase prefix adjacent to ticket key in branch name\n');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-adjacent-prefix-'));
  const git = (cmd: string): void => {
    execSync(`git ${cmd}`, { cwd: tmpDir, stdio: 'pipe' });
  };
  try {
    setupTestRepo(tmpDir, git);
    checkMatchingKey(tmpDir, git);
    checkMismatchedKey(tmpDir, git);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
  summarise(counts);
}

main();
