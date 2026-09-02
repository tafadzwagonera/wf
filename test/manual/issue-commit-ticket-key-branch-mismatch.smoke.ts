/**
 * Manual smoke test: wf issue:commit -k <key> validates against the
 * branch-embedded ticket key
 *
 * Run: nr test:manual -- test-issue-commit-ticket-key-branch-mismatch
 */

import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createReporter } from './support/reporter';

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

function main(): void {
  console.log('\nManual smoke test: issue:commit ticket-key vs branch-name validation\n');

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-ticket-mismatch-'));
  const git = (cmd: string): void => {
    execSync(`git ${cmd}`, { cwd: tmpDir, stdio: 'pipe' });
  };

  try {
    fs.writeFileSync(path.join(tmpDir, 'wf.config.js'), 'module.exports = {};\n');
    git('init');
    git('config user.email "test@example.com"');
    git('config user.name "Test User"');
    fs.writeFileSync(path.join(tmpDir, 'app.ts'), 'export const x = 1;\n');
    git('add .');
    git('commit -m init');
    git('checkout -b feature/WBP-1__add-thing');

    // Case A: mismatched -k, non-interactive (execSync's child has no TTY) — must exit non-zero with both keys shown
    fs.writeFileSync(path.join(tmpDir, 'app.ts'), 'export const x = 2;\n');
    git('add .');

    const mismatchResult = runCli('issue:commit -k WBP-2', tmpDir);
    const mismatchOutput = mismatchResult.stdout + mismatchResult.stderr;

    if (mismatchResult.exitCode !== 0) {
      pass('mismatched -k exits with a non-zero code instead of silently committing');
    } else {
      fail('mismatched -k should have exited non-zero', `exit code ${mismatchResult.exitCode}`);
    }

    if (mismatchOutput.includes('WBP-2') && mismatchOutput.includes('WBP-1')) {
      pass('mismatch message names both the explicit key and the branch key');
    } else {
      fail('mismatch message is missing one of the ticket keys', mismatchOutput.slice(0, 500));
    }

    let logAfterMismatch = '';
    try {
      logAfterMismatch = execSync('git log --oneline -1', { cwd: tmpDir, encoding: 'utf-8' });
    } catch { /* no commits yet, expected */ }
    if (!logAfterMismatch.includes('WBP-2')) {
      pass('no commit was created under the mismatched ticket key');
    } else {
      fail('a commit was created despite the mismatch', logAfterMismatch);
    }

    // Case B: matching -k — must succeed and commit normally
    const matchResult = runCli('issue:commit -k WBP-1 -m "test commit"', tmpDir);
    const matchOutput = matchResult.stdout + matchResult.stderr;

    if (matchResult.exitCode === 0) {
      pass('matching -k WBP-1 commits successfully');
    } else {
      fail('matching -k WBP-1 should have succeeded', matchOutput.slice(0, 500));
    }

    const matchLog = execSync('git log --oneline -1', { cwd: tmpDir, encoding: 'utf-8' });
    if (matchLog.includes('WBP-1')) {
      pass('committed subject line is prefixed with the matching ticket key WBP-1');
    } else {
      fail('committed subject line missing WBP-1 prefix', matchLog);
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  console.log('\n' + '='.repeat(60));
  console.log(`Results: ${counts.passed} passed   ${counts.failed} failed`);
  if (counts.failed === 0) console.log('All tests passed!');
  console.log('='.repeat(60));

  if (counts.failed > 0) process.exit(1);
}

main();
