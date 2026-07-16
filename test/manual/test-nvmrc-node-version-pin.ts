/**
 * Manual Test: .nvmrc node version pin
 *
 * Run: nr test:manual -- test-nvmrc-node-version-pin
 *
 * Verifies:
 *   1. .nvmrc exists at the repository root.
 *   2. .nvmrc contains a valid semver version string.
 *   3. The pinned version matches the running Node.js major version.
 *   4. package.json engines.node lower bound is consistent with .nvmrc.
 *   5. README.md mentions the .nvmrc file and prerequisites.
 */

import * as fs from 'fs';
import * as path from 'path';
import chalk from 'chalk';

const repoRoot = path.join(__dirname, '..', '..');
const nvmrcPath = path.join(repoRoot, '.nvmrc');
const packageJsonPath = path.join(repoRoot, 'package.json');
const readmePath = path.join(repoRoot, 'README.md');

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
  console.log(chalk.bold.cyan('\n\uD83E\uDDEA .nvmrc node version pin\n'));

  let passed = 0;
  let failed = 0;

  console.log(chalk.bold('Test 1: .nvmrc exists at repo root'));
  if (fs.existsSync(nvmrcPath)) {
    pass('.nvmrc found');
    passed += 1;
  } else {
    fail('.nvmrc not found');
    failed += 1;
  }

  const nvmrcContent = fs.existsSync(nvmrcPath) ? fs.readFileSync(nvmrcPath, 'utf8').trim() : '';
  const semverPattern = /^\d+\.\d+\.\d+$/;

  console.log(chalk.bold('Test 2: .nvmrc contains a valid semver version'));
  if (semverPattern.test(nvmrcContent)) {
    pass(`Version: ${nvmrcContent}`);
    passed += 1;
  } else {
    fail(`Invalid version string: "${nvmrcContent}"`);
    failed += 1;
  }

  console.log(chalk.bold('Test 3: Pinned major version matches running Node.js'));
  const pinnedMajor = nvmrcContent.split('.')[0];
  const runningMajor = process.version.replace(/^v/, '').split('.')[0];
  if (pinnedMajor === runningMajor) {
    pass(`Both are major version ${pinnedMajor}`);
    passed += 1;
  } else {
    fail(`Pinned=${pinnedMajor}, Running=${runningMajor}`);
    failed += 1;
  }

  console.log(chalk.bold('Test 4: package.json engines.node is consistent with .nvmrc'));
  try {
    const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
    const enginesNode: string | undefined = pkg.engines?.node;

    if (!enginesNode) {
      fail('package.json missing engines.node field');
      failed += 1;
    } else {
      const lowerBoundMatch = /(\d+)\.(\d+)/.exec(enginesNode);
      const nvmrcMajorMinor = nvmrcContent.split('.').slice(0, 2).join('.');

      if (lowerBoundMatch) {
        const enginesMajorMinor = `${lowerBoundMatch[1]}.${lowerBoundMatch[2]}`;
        if (enginesMajorMinor === nvmrcMajorMinor) {
          pass(`engines.node "${enginesNode}" aligns with .nvmrc ${nvmrcContent}`);
          passed += 1;
        } else {
          fail(`engines.node lower bound ${enginesMajorMinor} does not match .nvmrc ${nvmrcMajorMinor}`);
          failed += 1;
        }
      } else {
        fail(`Cannot parse engines.node: "${enginesNode}"`);
        failed += 1;
      }
    }
  } catch (error: any) {
    fail(`package.json read failed: ${error.message}`);
    failed += 1;
  }

  console.log(chalk.bold('Test 5: README.md mentions .nvmrc and prerequisites'));
  try {
    const readme = fs.readFileSync(readmePath, 'utf8');
    const mentionsNvmrc = readme.includes('.nvmrc');
    const mentionsPrerequisites = readme.includes('## Prerequisites') || readme.includes('### Prerequisites');

    if (mentionsNvmrc && mentionsPrerequisites) {
      pass('README mentions .nvmrc and has Prerequisites section');
      passed += 1;
    } else {
      const missing = [
        !mentionsNvmrc ? '.nvmrc reference' : null,
        !mentionsPrerequisites ? 'Prerequisites section' : null,
      ]
        .filter(Boolean)
        .join(', ');
      fail(`README missing: ${missing}`);
      failed += 1;
    }
  } catch (error: any) {
    fail(`README read failed: ${error.message}`);
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
