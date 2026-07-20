/**
 * Manual smoke test: project-root guard in run-manual-test.ts
 *
 * Run: nr test:manual -- test-project-root-guard
 *
 * Verifies:
 *   1. The manual test runner succeeds from the wf project root (this test itself proves it).
 *   2. A copy of the runner in a foreign directory (different package.json name) exits with
 *      a clear guard error.
 *   3. A copy of the runner in a directory with no package.json exits with a clear guard error.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execSync } from 'child_process';
import chalk from 'chalk';

let passed = 0;
let failed = 0;

const pass = (message: string): void => {
  console.log(chalk.green(`  \u2713 ${message}`));
  passed += 1;
};

const fail = (message: string, detail?: string): void => {
  console.error(chalk.red(`  \u2717 ${message}${detail ? `\n    \u2192 ${detail}` : ''}`));
  failed += 1;
};

const WF_ROOT = path.resolve(__dirname, '..', '..');
const RUNNER_SOURCE = path.join(WF_ROOT, 'run-manual-test.ts');

/**
 * Copy the runner script to a temp directory and execute it via ts-node.
 * The guard checks __dirname, so the script must physically reside in the target dir.
 *
 * @param tmpDir - Directory to copy the runner into and execute from
 * @returns Exit code and stderr from the subprocess
 */
function runCopiedRunnerIn(tmpDir: string): { exitCode: number; stderr: string } {
  const copiedRunner = path.join(tmpDir, 'run-manual-test.ts');
  let source = fs.readFileSync(RUNNER_SOURCE, 'utf8');

  // Rewrite relative moduleRequire paths to absolute so they resolve from the temp dir
  source = source.replaceAll(
    'moduleRequire(\'./src/',
    `moduleRequire('${WF_ROOT}/src/`,
  );

  fs.writeFileSync(copiedRunner, source);

  try {
    execSync(
      `npx ts-node --project "${path.join(WF_ROOT, 'tsconfig.json')}" "${copiedRunner}" nonexistent-test`,
      { cwd: tmpDir, stdio: 'pipe', env: { ...process.env, NODE_OPTIONS: '' } },
    );
    return { exitCode: 0, stderr: '' };
  } catch (error: unknown) {
    const execError = error as { status: number; stderr?: Buffer };
    return {
      exitCode: execError.status ?? 1,
      stderr: execError.stderr?.toString() ?? '',
    };
  }
}

async function main(): Promise<void> {
  console.log(chalk.bold.cyan('\n  project-root guard smoke test\n'));

  // --- Test 1: runner loads from wf root (this test proves it) ---
  console.log(chalk.bold('Test 1: runner loads successfully from the wf project root'));
  const wfPackageJson = JSON.parse(fs.readFileSync(path.join(WF_ROOT, 'package.json'), 'utf8'));
  if (wfPackageJson.name === 'wf') {
    pass('This test is running inside the wf project (guard passed at startup)');
  } else {
    fail('package.json name is not wf', `got: ${wfPackageJson.name}`);
  }

  // --- Test 2: foreign directory with a different package.json name ---
  console.log(chalk.bold('Test 2: runner rejects a foreign project directory'));
  const foreignDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-guard-foreign-'));
  fs.writeFileSync(path.join(foreignDir, 'package.json'), JSON.stringify({ name: 'not-wf' }));

  try {
    const result = runCopiedRunnerIn(foreignDir);
    if (result.exitCode !== 0 && result.stderr.includes('Manual tests must be run from the wf project root')) {
      pass('Exit code is non-zero and stderr contains the expected guard message');
    } else {
      fail(
        'Guard did not produce expected output',
        `exitCode=${result.exitCode}, stderr=${result.stderr.slice(0, 300)}`,
      );
    }
  } finally {
    fs.rmSync(foreignDir, { recursive: true, force: true });
  }

  // --- Test 3: directory with no package.json ---
  console.log(chalk.bold('Test 3: runner rejects a directory without package.json'));
  const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-guard-empty-'));

  try {
    const result = runCopiedRunnerIn(emptyDir);
    if (result.exitCode !== 0 && result.stderr.includes('Manual tests must be run from the wf project root')) {
      pass('Exit code is non-zero and stderr contains the expected guard message');
    } else {
      fail(
        'Guard did not produce expected output',
        `exitCode=${result.exitCode}, stderr=${result.stderr.slice(0, 300)}`,
      );
    }
  } finally {
    fs.rmSync(emptyDir, { recursive: true, force: true });
  }

  // --- Summary ---
  console.log('\n' + '\u2501'.repeat(50));
  console.log(`Results: ${passed} passed   ${failed} failed`);
  if (failed === 0) console.log('All tests passed!');
  console.log('\u2501'.repeat(50));

  if (failed > 0) process.exit(1);
}

main();
