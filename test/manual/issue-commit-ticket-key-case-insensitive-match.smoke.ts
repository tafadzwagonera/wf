/**
 * Manual smoke test: ticket key comparison against the branch name is
 * case-insensitive
 *
 * Run: nr test:manual issue-commit-ticket-key-case-insensitive-match.smoke.ts
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

const makeGitRunner = (cwd: string) =>
  (cmd: string): void => {
    execSync(`git ${cmd}`, { cwd, stdio: 'pipe' });
  };

function setupRepo(tmpDir: string): void {
  const git = makeGitRunner(tmpDir);
  fs.writeFileSync(path.join(tmpDir, 'wf.config.js'), 'module.exports = {};\n');
  git('init');
  git('config user.email "test@example.com"');
  git('config user.name "Test User"');
  fs.writeFileSync(path.join(tmpDir, 'app.ts'), 'export const x = 1;\n');
  git('add .');
  git('commit -m init');
  git('checkout -b feature/WBP-1__add-thing');
}

function checkExitSucceeds(result: CliResult): void {
  const output = result.stdout + result.stderr;
  if (result.exitCode === 0) {
    pass('lowercase -k wbp-1 on branch WBP-1 exits 0 (treated as a match)');
  } else {
    fail(
      'lowercase -k wbp-1 should have been treated as a match',
      `exit code ${result.exitCode}\n${output.slice(0, 500)}`
    );
  }
}

function checkNoMismatchWarning(output: string): void {
  if (!/does not match/i.test(output)) {
    pass('no mismatch warning printed for the case-insensitive match');
  } else {
    fail('unexpected mismatch warning for a case-insensitive match', output.slice(0, 500));
  }
}

function checkCasingPreserved(log: string): void {
  if (log.includes('wbp-1:')) {
    pass('committed subject preserves the exact casing passed via -k ("wbp-1:")');
  } else {
    fail('committed subject does not preserve the passed casing', log);
  }
}

function verifyCommitResults(result: CliResult, tmpDir: string): void {
  const output = result.stdout + result.stderr;
  checkExitSucceeds(result);
  checkNoMismatchWarning(output);
  checkCasingPreserved(execSync('git log --oneline -1', { cwd: tmpDir, encoding: 'utf-8' }));
}

function runScenario(): void {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-case-insensitive-'));
  try {
    setupRepo(tmpDir);
    const git = makeGitRunner(tmpDir);
    // Case A: lowercase -k matching the branch's uppercase key — must be treated as a match
    fs.writeFileSync(path.join(tmpDir, 'app.ts'), 'export const x = 2;\n');
    git('add .');
    verifyCommitResults(runCli('issue:commit -k wbp-1 -m "test commit"', tmpDir), tmpDir);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

function main(): void {
  console.log('\nManual smoke test: issue:commit ticket-key case-insensitive match\n');
  runScenario();
  summarise(counts);
}

main();
