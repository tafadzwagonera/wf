/**
 * Manual smoke test: --dry-run with a mismatched ticket key warns but does
 * not throw or commit
 *
 * Run: nr test:manual -- test-issue-commit-dry-run-ticket-key-mismatch
 */

import { execSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const DIST_MAIN = path.join(__dirname, '../../dist/main.js');

let passed = 0;
let failed = 0;

const pass = (msg: string): void => {
  console.log(`  ✓ ${msg}`);
  passed++;
};
const fail = (msg: string, detail?: string): void => {
  console.error(`  ✗ ${msg}${detail ? `\n    -> ${detail}` : ''}`);
  failed++;
};

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
  console.log('\nManual smoke test: issue:commit --dry-run ticket-key mismatch\n');

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-dryrun-mismatch-'));
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

    fs.writeFileSync(path.join(tmpDir, 'app.ts'), 'export const x = 2;\n');
    git('add .');

    const dryRunResult = runCli('issue:commit -k WBP-2 --dry-run', tmpDir);
    const dryRunOutput = dryRunResult.stdout + dryRunResult.stderr;

    if (dryRunResult.exitCode === 0) {
      pass('--dry-run with mismatched -k exits 0 (does not hard-fail)');
    } else {
      fail('--dry-run with mismatched -k should exit 0', `exit code ${dryRunResult.exitCode}\n${dryRunOutput.slice(0, 500)}`);
    }

    if (dryRunOutput.includes('WBP-2') && dryRunOutput.includes('WBP-1')) {
      pass('--dry-run warning names both the explicit key and the branch key');
    } else {
      fail('--dry-run warning is missing one of the ticket keys', dryRunOutput.slice(0, 500));
    }

    if (/dry-run/i.test(dryRunOutput)) {
      pass('--dry-run output indicates no changes were made');
    } else {
      fail('--dry-run output does not mention dry-run/no changes', dryRunOutput.slice(0, 500));
    }

    const logAfterDryRun = execSync('git log --oneline', { cwd: tmpDir, encoding: 'utf-8' });
    if ((logAfterDryRun.match(/\n/g) ?? []).length === 0 || !logAfterDryRun.includes('WBP-2')) {
      pass('no commit was created by the --dry-run invocation');
    } else {
      fail('a commit was unexpectedly created during --dry-run', logAfterDryRun);
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  console.log('\n' + '='.repeat(60));
  console.log(`Results: ${passed} passed   ${failed} failed`);
  if (failed === 0) console.log('All tests passed!');
  console.log('='.repeat(60));

  if (failed > 0) process.exit(1);
}

main();
