/**
 * Manual smoke test: wf issue:commit -k <key> validates against the
 * branch-embedded ticket key
 *
 * Run: nr test:manual issue-commit-ticket-key-branch-mismatch.smoke.ts
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

function setupRepo(tmpDir: string): void {
  const git = (cmd: string): void => {
    execSync(`git ${cmd}`, { cwd: tmpDir, stdio: 'pipe' });
  };
  fs.writeFileSync(path.join(tmpDir, 'wf.config.js'), 'module.exports = {};\n');
  git('init');
  git('config user.email "test@example.com"');
  git('config user.name "Test User"');
  fs.writeFileSync(path.join(tmpDir, 'app.ts'), 'export const x = 1;\n');
  git('add .');
  git('commit -m init');
  git('checkout -b feature/WBP-1__add-thing');
}

function checkMismatchExitCode(result: CliResult): void {
  if (result.exitCode === 0) {
    fail('mismatched -k should have exited non-zero', `exit code ${result.exitCode}`);
  } else {
    pass('mismatched -k exits with a non-zero code instead of silently committing');
  }
}

function checkMismatchBothKeys(output: string): void {
  if (output.includes('WBP-2') && output.includes('WBP-1')) {
    pass('mismatch message names both the explicit key and the branch key');
  } else {
    fail('mismatch message is missing one of the ticket keys', output.slice(0, 500));
  }
}

function checkMismatchNoCommit(tmpDir: string): void {
  let logAfterMismatch = '';
  try {
    logAfterMismatch = execSync('git log --oneline -1', { cwd: tmpDir, encoding: 'utf-8' });
  } catch { /* no commits yet, expected */ }
  if (logAfterMismatch.includes('WBP-2')) {
    fail('a commit was created despite the mismatch', logAfterMismatch);
  } else {
    pass('no commit was created under the mismatched ticket key');
  }
}

function checkMismatchCase(tmpDir: string): void {
  const git = (cmd: string): void => {
    execSync(`git ${cmd}`, { cwd: tmpDir, stdio: 'pipe' });
  };
  // Case A: mismatched -k, non-interactive (execSync's child has no TTY) — must exit non-zero with both keys shown
  fs.writeFileSync(path.join(tmpDir, 'app.ts'), 'export const x = 2;\n');
  git('add .');
  const result = runCli('issue:commit -k WBP-2', tmpDir);
  const output = result.stdout + result.stderr;
  checkMismatchExitCode(result);
  checkMismatchBothKeys(output);
  checkMismatchNoCommit(tmpDir);
}

function checkMatchCase(tmpDir: string): void {
  // Case B: matching -k — must succeed and commit normally
  const result = runCli('issue:commit -k WBP-1 -m "test commit"', tmpDir);
  const output = result.stdout + result.stderr;
  if (result.exitCode === 0) {
    pass('matching -k WBP-1 commits successfully');
  } else {
    fail('matching -k WBP-1 should have succeeded', output.slice(0, 500));
  }
  const matchLog = execSync('git log --oneline -1', { cwd: tmpDir, encoding: 'utf-8' });
  if (matchLog.includes('WBP-1')) {
    pass('committed subject line is prefixed with the matching ticket key WBP-1');
  } else {
    fail('committed subject line missing WBP-1 prefix', matchLog);
  }
}

function runScenario(): void {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-ticket-mismatch-'));
  try {
    setupRepo(tmpDir);
    checkMismatchCase(tmpDir);
    checkMatchCase(tmpDir);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

function main(): void {
  console.log('\nManual smoke test: issue:commit ticket-key vs branch-name validation\n');
  runScenario();
  summarise(counts);
}

main();
