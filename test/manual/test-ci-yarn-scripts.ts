/**
 * Manual Test: CI yarn script consistency
 *
 * Run: nr test:manual -- test-ci-yarn-scripts
 *
 * Verifies:
 *   1. CI workflow uses `yarn` (not `npm run`) for all script invocations.
 *   2. package.json scripts section contains no `npm run` references.
 *   3. The `test:ci` script exists and resolves to `jest --passWithNoTests`.
 *   4. `yarn test:ci` exits cleanly.
 *   5. help-output error message references `yarn build` (not `npm run build`).
 */

import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import chalk from 'chalk';

const repoRoot = path.join(__dirname, '..', '..');
const ciPath = path.join(repoRoot, '.github', 'workflows', 'ci.yml');
const packageJsonPath = path.join(repoRoot, 'package.json');
const helpOutputPath = path.join(repoRoot, 'src', 'bootstrap', 'help-output.ts');

/**
 * Print a pass result.
 *
 * @param message Human-readable pass message
 * @returns Void
 */
const pass = (message: string): void => {
  console.log(chalk.green(`  \u2713 ${message}`));
};

/**
 * Print a failure result.
 *
 * @param message Human-readable failure message
 * @returns Void
 */
const fail = (message: string): void => {
  console.error(chalk.red(`  \u2717 ${message}`));
};

async function main() {
  console.log(chalk.bold.cyan('\n\uD83E\uDDEA CI yarn script consistency\n'));

  let passed = 0;
  let failed = 0;

  console.log(chalk.bold('Test 1: CI workflow uses yarn for all run steps'));
  try {
    const ciContent = fs.readFileSync(ciPath, 'utf8');
    const runLines = ciContent
      .split('\n')
      .filter(line => /^\s+run:\s/.test(line))
      .map(line => line.trim());
    const npmRunLines = runLines.filter(line => line.includes('npm run'));

    if (npmRunLines.length === 0) {
      pass('No npm run references in CI workflow run steps');
      passed += 1;
    } else {
      fail(`Found npm run in CI: ${npmRunLines.join('; ')}`);
      failed += 1;
    }
  } catch (error: any) {
    fail(`CI file read failed: ${error.message}`);
    failed += 1;
  }

  console.log(chalk.bold('Test 2: package.json scripts contain no npm run references'));
  try {
    const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
    const scripts = pkg.scripts ?? {};
    const npmRunScripts = Object.entries(scripts).filter(([, value]) => (value as string).includes('npm run'));

    if (npmRunScripts.length === 0) {
      pass('No npm run in package.json scripts');
      passed += 1;
    } else {
      fail(`npm run found in: ${npmRunScripts.map(([k]) => k).join(', ')}`);
      failed += 1;
    }
  } catch (error: any) {
    fail(`package.json read failed: ${error.message}`);
    failed += 1;
  }

  console.log(chalk.bold('Test 3: test:ci script exists and is correct'));
  try {
    const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
    const testCi = pkg.scripts?.['test:ci'];

    if (testCi === 'jest --passWithNoTests') {
      pass('test:ci = "jest --passWithNoTests"');
      passed += 1;
    } else {
      fail(`test:ci is "${testCi}" (expected "jest --passWithNoTests")`);
      failed += 1;
    }
  } catch (error: any) {
    fail(`Script check failed: ${error.message}`);
    failed += 1;
  }

  console.log(chalk.bold('Test 4: yarn test:ci exits cleanly'));
  try {
    execSync('yarn test:ci', {
      cwd: repoRoot,
      encoding: 'utf-8',
      stdio: 'pipe',
    });
    pass('yarn test:ci exited with code 0');
    passed += 1;
  } catch (error: any) {
    fail(`yarn test:ci failed: ${error.message}`);
    failed += 1;
  }

  console.log(chalk.bold('Test 5: help-output references yarn build, not npm run build'));
  try {
    const helpOutput = fs.readFileSync(helpOutputPath, 'utf8');

    if (helpOutput.includes('yarn build') && !helpOutput.includes('npm run build')) {
      pass('help-output.ts references yarn build');
      passed += 1;
    } else {
      fail('help-output.ts still references npm run build');
      failed += 1;
    }
  } catch (error: any) {
    fail(`help-output.ts read failed: ${error.message}`);
    failed += 1;
  }

  console.log(chalk.bold('\nSummary'));
  console.log(`  Passed: ${passed}`);
  console.log(`  Failed: ${failed}`);

  if (failed > 0) {
    process.exit(1);
  }
}

void main();
