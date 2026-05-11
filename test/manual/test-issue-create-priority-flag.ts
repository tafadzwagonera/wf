/**
 * Manual Test: issue:create priority flag smoke test
 *
 * Run: nr test:manual -- test-issue-create-priority-flag
 *
 * Verifies:
 *   1. `issue:create -h` includes `--priority <priority>`.
 *   2. Generated command-help catalog includes the priority option.
 *   3. README generated command docs include the priority option row.
 */

import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import chalk from 'chalk';

const repoRoot = path.join(__dirname, '..', '..');
const docsCatalogPath = path.join(
  repoRoot,
  'docs',
  'commands-help.catalog.json',
);
const readmePath = path.join(repoRoot, 'README.md');

/**
 * Execute a shell command and return stdout text.
 *
 * @param command - Shell command to execute.
 * @returns UTF-8 command output.
 */
const run = (command: string): string =>
  execSync(command, {
    encoding: 'utf8',
    stdio: 'pipe',
    cwd: repoRoot,
  });

/**
 * Print a passing assertion message.
 *
 * @param message - Human-readable assertion result.
 * @returns No return value.
 */
const pass = (message: string): void => {
  console.log(chalk.green(`  ✓ ${message}`));
};

/**
 * Print a failing assertion message.
 *
 * @param message - Human-readable assertion failure.
 * @returns No return value.
 */
const fail = (message: string): void => {
  console.error(chalk.red(`  ✗ ${message}`));
};

/**
 * Execute the smoke test suite.
 *
 * @returns Promise that resolves when checks complete.
 */
const main = async (): Promise<void> => {
  console.log(chalk.bold.cyan('\n🧪 issue:create priority flag smoke test\n'));

  let failed = 0;

  console.log(chalk.bold('Test 1: help text includes priority option'));
  try {
    const helpOutput = run('yarn start issue:create -h');
    if (helpOutput.includes('--priority <priority>')) {
      pass('help output contains --priority <priority>');
    } else {
      fail('help output is missing --priority <priority>');
      failed += 1;
    }
  } catch (error: any) {
    fail(error.message);
    failed += 1;
  }

  console.log(chalk.bold('Test 2: help catalog includes priority option'));
  try {
    const catalog = fs.readFileSync(docsCatalogPath, 'utf8');
    if (
      catalog.includes('"issue:create"') &&
      catalog.includes('--priority <priority>')
    ) {
      pass('catalog includes issue:create priority option');
    } else {
      fail('catalog is missing issue:create priority option');
      failed += 1;
    }
  } catch (error: any) {
    fail(error.message);
    failed += 1;
  }

  console.log(
    chalk.bold('Test 3: README command docs include priority option'),
  );
  try {
    const readme = fs.readFileSync(readmePath, 'utf8');
    if (
      readme.includes('BEGIN GENERATED COMMAND DOCS: issue:create') &&
      readme.includes('`--priority <priority>`')
    ) {
      pass('README issue:create docs include priority option');
    } else {
      fail('README issue:create docs are missing priority option');
      failed += 1;
    }
  } catch (error: any) {
    fail(error.message);
    failed += 1;
  }

  if (failed > 0) {
    process.exit(1);
  }

  console.log(chalk.green('\nAll checks passed.\n'));
};

void main();
