/**
 * Manual smoke test: ticket key comparison against the branch name is
 * case-insensitive
 *
 * Run: nr test:manual -- test-issue-commit-ticket-key-case-insensitive-match
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
  console.log('\nManual smoke test: issue:commit ticket-key case-insensitive match\n');

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-case-insensitive-'));
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

    // Case A: lowercase -k matching the branch's uppercase key — must be treated as a match
    fs.writeFileSync(path.join(tmpDir, 'app.ts'), 'export const x = 2;\n');
    git('add .');

    const matchResult = runCli('issue:commit -k wbp-1 -m "test commit"', tmpDir);
    const matchOutput = matchResult.stdout + matchResult.stderr;

    if (matchResult.exitCode === 0) {
      pass('lowercase -k wbp-1 on branch WBP-1 exits 0 (treated as a match)');
    } else {
      fail('lowercase -k wbp-1 should have been treated as a match', `exit code ${matchResult.exitCode}\n${matchOutput.slice(0, 500)}`);
    }

    if (/does not match/i.test(matchOutput)) {
      fail('unexpected mismatch warning for a case-insensitive match', matchOutput.slice(0, 500));
    } else {
      pass('no mismatch warning printed for the case-insensitive match');
    }

    const logAfterMatch = execSync('git log --oneline -1', { cwd: tmpDir, encoding: 'utf-8' });
    if (logAfterMatch.includes('wbp-1:')) {
      pass('committed subject preserves the exact casing passed via -k ("wbp-1:")');
    } else {
      fail('committed subject does not preserve the passed casing', logAfterMatch);
    }

    // Case B: a genuinely different key in a different case must still mismatch
    fs.writeFileSync(path.join(tmpDir, 'app.ts'), 'export const x = 3;\n');
    git('add .');

    const mismatchResult = runCli('issue:commit -k wbp-2', tmpDir);
    if (mismatchResult.exitCode !== 0) {
      pass('a genuinely different key (wbp-2) still triggers the mismatch path (case-insensitivity is not a blanket bypass)');
    } else {
      fail('wbp-2 should have mismatched against branch key WBP-1', `exit code ${mismatchResult.exitCode}`);
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
