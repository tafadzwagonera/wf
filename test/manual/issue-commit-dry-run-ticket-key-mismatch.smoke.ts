/**
 * Manual smoke test: --dry-run with a mismatched ticket key warns but does
 * not throw or commit
 *
 * Run: nr test:manual issue-commit-dry-run-ticket-key-mismatch.smoke.ts
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
  fs.writeFileSync(path.join(tmpDir, 'app.ts'), 'export const x = 2;\n');
  git('add .');
}

function checkExitCode(result: CliResult): void {
  if (result.exitCode === 0) {
    pass('--dry-run with mismatched -k exits 0 (does not hard-fail)');
  } else {
    fail('--dry-run with mismatched -k should exit 0', `exit code ${result.exitCode}\n${(result.stdout + result.stderr).slice(0, 500)}`);
  }
}

function checkWarningKeys(output: string): void {
  if (output.includes('WBP-2') && output.includes('WBP-1')) {
    pass('--dry-run warning names both the explicit key and the branch key');
  } else {
    fail('--dry-run warning is missing one of the ticket keys', output.slice(0, 500));
  }
}

function checkDryRunMention(output: string): void {
  if (/dry-run/i.test(output)) {
    pass('--dry-run output indicates no changes were made');
  } else {
    fail('--dry-run output does not mention dry-run/no changes', output.slice(0, 500));
  }
}

function checkNoCommitCreated(log: string): void {
  if (log.includes('WBP-2')) {
    fail('a commit was unexpectedly created during --dry-run', log);
  } else {
    pass('no commit was created by the --dry-run invocation');
  }
}

function runScenario(): { dryRunResult: CliResult; logAfterDryRun: string } {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-dryrun-mismatch-'));
  try {
    setupRepo(tmpDir);
    const dryRunResult = runCli('issue:commit -k WBP-2 --dry-run', tmpDir);
    const logAfterDryRun = execSync('git log --oneline', { cwd: tmpDir, encoding: 'utf-8' });
    return { dryRunResult, logAfterDryRun };
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

function main(): void {
  console.log('\nManual smoke test: issue:commit --dry-run ticket-key mismatch\n');
  const { dryRunResult, logAfterDryRun } = runScenario();
  const dryRunOutput = dryRunResult.stdout + dryRunResult.stderr;
  checkExitCode(dryRunResult);
  checkWarningKeys(dryRunOutput);
  checkDryRunMention(dryRunOutput);
  checkNoCommitCreated(logAfterDryRun);
  summarise(counts);
}

main();
