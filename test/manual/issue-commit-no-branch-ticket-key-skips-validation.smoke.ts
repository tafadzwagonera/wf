/**
 * Manual smoke test: no validation attempted when the branch has no
 * parseable ticket key
 *
 * Run: nr test:manual issue-commit-no-branch-ticket-key-skips-validation.smoke.ts
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

function setupGitCommand(tmpDir: string): (cmd: string) => void {
  return (cmd: string): void => {
    execSync(`git ${cmd}`, { cwd: tmpDir, stdio: 'pipe' });
  };
}

function setupNoBranchKeyRepo(tmpDir: string): string {
  const git = setupGitCommand(tmpDir);
  fs.writeFileSync(path.join(tmpDir, 'wf.config.js'), 'module.exports = {};\n');
  git('init');
  git('config user.email "test@example.com"');
  git('config user.name "Test User"');
  fs.writeFileSync(path.join(tmpDir, 'app.ts'), 'export const x = 1;\n');
  git('add .');
  git('commit -m init');
  return execSync('git rev-parse --abbrev-ref HEAD', { cwd: tmpDir, encoding: 'utf-8' }).trim();
}

function checkExitSucceeds(result: CliResult, defaultBranch: string): void {
  const output = result.stdout + result.stderr;
  if (result.exitCode === 0) {
    pass(`-k WBP-9 on branch '${defaultBranch}' (no embedded ticket key) exits 0`);
  } else {
    fail(`-k WBP-9 on branch '${defaultBranch}' should have exited 0`, `exit code ${result.exitCode}\n${output.slice(0, 500)}`);
  }
}

function checkNoMismatchWarning(output: string): void {
  if (/does not match/i.test(output)) {
    fail('unexpected mismatch warning on a branch with no ticket key', output.slice(0, 500));
  } else {
    pass('no mismatch warning printed when the branch has no parseable ticket key');
  }
}

function checkCommitHasKey(log: string): void {
  if (log.includes('WBP-9:')) {
    pass('commit was created directly under the explicit ticket key WBP-9');
  } else {
    fail('commit subject missing the explicit WBP-9 prefix', log);
  }
}

function runScenario(): { result: CliResult; log: string; defaultBranch: string } {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-no-branch-key-'));
  try {
    const defaultBranch = setupNoBranchKeyRepo(tmpDir);
    const git = setupGitCommand(tmpDir);
    // Case A: default branch (no ticket key embedded) + explicit -k must skip validation entirely
    fs.writeFileSync(path.join(tmpDir, 'app.ts'), 'export const x = 2;\n');
    git('add .');
    const result = runCli('issue:commit -k WBP-9 -m "test commit"', tmpDir);
    const log = execSync('git log --oneline -1', { cwd: tmpDir, encoding: 'utf-8' });
    return { result, log, defaultBranch };
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

function main(): void {
  console.log('\nManual smoke test: issue:commit skips validation with no branch ticket key\n');
  const { result, log, defaultBranch } = runScenario();
  const output = result.stdout + result.stderr;
  checkExitSucceeds(result, defaultBranch);
  checkNoMismatchWarning(output);
  checkCommitHasKey(log);
  summarise(counts);
}

main();
