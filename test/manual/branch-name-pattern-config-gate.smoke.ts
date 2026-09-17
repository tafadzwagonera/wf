/**
 * Manual smoke test: invalid git.branchNamePattern regex fails config load loudly
 *
 * Verifies:
 *   1. The compiled CLI exits non-zero when wf.config.js carries a
 *      git.branchNamePattern that does not compile as a regular expression
 *   2. The error output names git.branchNamePattern
 *   3. The aborted run leaves no .wf/ artifacts in the project
 *   4. A valid pattern passes the config gate (any later failure is not the
 *      config-validation error)
 *
 * Run: nr test:manual -- branch-name-pattern-config-gate.smoke
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
  output: string;
}

const runCli = (args: string, cwd: string): CliResult => {
  try {
    const stdout = execSync(`node ${DIST_MAIN} ${args}`, {
      encoding: 'utf-8', cwd, timeout: 30_000, stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { exitCode: 0, output: stdout };
  } catch (err: any) {
    return { exitCode: err.status ?? 1, output: `${err.stdout ?? ''}${err.stderr ?? ''}` };
  }
};

function main(): void {
  console.log('\nManual smoke test: invalid git.branchNamePattern fails config load\n');

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-config-gate-'));

  try {
    fs.writeFileSync(
      path.join(tmpDir, 'wf.config.js'),
      "module.exports = { git: { branchNamePattern: '[' } };\n"
    );

    const invalidResult = runCli('issue:implement -k WBP-1 --dry-run', tmpDir);
    if (invalidResult.exitCode === 0) {
      fail('CLI should exit non-zero on an invalid git.branchNamePattern regex', invalidResult.output.slice(0, 500));
    } else {
      pass(`CLI exits non-zero (${invalidResult.exitCode}) on an invalid git.branchNamePattern regex`);
    }

    if (invalidResult.output.includes('git.branchNamePattern')) {
      pass('error output names git.branchNamePattern');
    } else {
      fail('error output should name git.branchNamePattern', invalidResult.output.slice(0, 500));
    }

    if (fs.existsSync(path.join(tmpDir, '.wf'))) {
      fail('aborted run should leave no .wf/ artifacts in the project');
    } else {
      pass('aborted run left no .wf/ artifacts in the project');
    }

    fs.writeFileSync(
      path.join(tmpDir, 'wf.config.js'),
      "module.exports = { git: { branchNamePattern: '^team\\\\/[a-z-]+$' } };\n"
    );
    const validResult = runCli('issue:implement -k WBP-1 --dry-run', tmpDir);
    if (validResult.output.includes('Invalid wf config')) {
      fail('a valid pattern should pass the config gate', validResult.output.slice(0, 500));
    } else {
      pass('a valid pattern passes the config gate (no "Invalid wf config" error)');
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  console.log(`\n${counts.passed} passed, ${counts.failed} failed`);
  if (counts.failed > 0) process.exit(1);
  console.log('\nManual smoke test passed: git.branchNamePattern config gate');
}

main();
