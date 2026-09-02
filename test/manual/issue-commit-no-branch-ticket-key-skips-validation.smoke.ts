/**
 * Manual smoke test: no validation attempted when the branch has no
 * parseable ticket key
 *
 * Run: nr test:manual -- test-issue-commit-no-branch-ticket-key-skips-validation
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
  console.log('\nManual smoke test: issue:commit skips validation with no branch ticket key\n');

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-no-branch-key-'));
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

    const defaultBranch = execSync('git rev-parse --abbrev-ref HEAD', { cwd: tmpDir, encoding: 'utf-8' }).trim();

    // Case A: default branch (no ticket key embedded) + explicit -k must skip validation entirely
    fs.writeFileSync(path.join(tmpDir, 'app.ts'), 'export const x = 2;\n');
    git('add .');

    const noKeyBranchResult = runCli('issue:commit -k WBP-9 -m "test commit"', tmpDir);
    const noKeyBranchOutput = noKeyBranchResult.stdout + noKeyBranchResult.stderr;

    if (noKeyBranchResult.exitCode === 0) {
      pass(`-k WBP-9 on branch '${defaultBranch}' (no embedded ticket key) exits 0`);
    } else {
      fail(`-k WBP-9 on branch '${defaultBranch}' should have exited 0`, `exit code ${noKeyBranchResult.exitCode}\n${noKeyBranchOutput.slice(0, 500)}`);
    }

    if (!/does not match/i.test(noKeyBranchOutput)) {
      pass('no mismatch warning printed when the branch has no parseable ticket key');
    } else {
      fail('unexpected mismatch warning on a branch with no ticket key', noKeyBranchOutput.slice(0, 500));
    }

    const logNoKeyBranch = execSync('git log --oneline -1', { cwd: tmpDir, encoding: 'utf-8' });
    if (logNoKeyBranch.includes('WBP-9:')) {
      pass('commit was created directly under the explicit ticket key WBP-9');
    } else {
      fail('commit subject missing the explicit WBP-9 prefix', logNoKeyBranch);
    }

    // Case B: same repo, now on a branch WITH an embedded ticket key — mismatch must fire
    git('checkout -b feature/WBP-1__add-thing');
    fs.writeFileSync(path.join(tmpDir, 'app.ts'), 'export const x = 3;\n');
    git('add .');

    const withKeyBranchResult = runCli('issue:commit -k WBP-9', tmpDir);
    if (withKeyBranchResult.exitCode !== 0) {
      pass('the same -k value DOES trigger the mismatch path once the branch embeds a different ticket key');
    } else {
      fail('expected the mismatch path to fire on feature/WBP-1__add-thing', `exit code ${withKeyBranchResult.exitCode}`);
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
