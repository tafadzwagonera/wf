/**
 * Manual Test: issue help/doc sync smoke test
 *
 * Run: nr test:manual issue-help-doc-sync.smoke.ts
 *
 * Verifies:
 *   1. `issue:generate -h` includes short and long flags.
 *   2. Option descriptions in help output start at the same column.
 *   3. No rendered help line exceeds 80 characters.
 *   4. README generated command-doc blocks exist for issue stage commands.
 *   5. Generated docs sync is idempotent.
 */

import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import chalk from 'chalk';
import { createReporter } from './support/reporter';

const repoRoot = path.join(__dirname, '..', '..');
const readmePath = path.join(repoRoot, 'README.md');

const { counts, pass, fail } = createReporter();

/**
 * Run a shell command in the repository root and capture stdout.
 *
 * @param command Shell command to execute
 * @returns Command stdout as UTF-8 text
 */
const run = (command: string): string =>
  execSync(command, {
    cwd: repoRoot,
    encoding: 'utf-8',
    stdio: 'pipe',
  });

/**
 * Count columns where option descriptions begin.
 *
 * @param helpOutput Full rendered CLI help output
 * @returns Unique starting columns for option descriptions
 */
const getDescriptionColumns = (helpOutput: string): number[] => {
  const lines = helpOutput.split('\n');
  const optionLines = lines.filter(line => line.startsWith('  --') || line.startsWith('  -'));

  return optionLines.map(line => {
    const flagSection = /^ {2}.+?(?= {2,}\S)/.exec(line);
    if (!flagSection) {
      return -1;
    }

    let index = flagSection[0].length;
    while (index < line.length && line[index] === ' ') {
      index += 1;
    }

    return index;
  });
};

function verifyRequiredFlags(helpOutput: string): void {
  if (
    helpOutput.includes('-f, --format <format>')
    && helpOutput.includes('-r, --repos <repos...>')
    && helpOutput.includes('-t, --title <title>')
  ) {
    pass('Help output includes expected abbreviated flags');
  } else {
    fail('Help output is missing one or more abbreviated flags');
  }
}

function runTest1(): void {
  console.log(chalk.bold('Test 1: issue:generate help includes short and long flags'));
  try {
    const helpOutput = run('yarn start issue:generate -h');
    verifyRequiredFlags(helpOutput);
  } catch (error: any) {
    fail(`Help invocation failed: ${error.message}`);
  }
}

function verifyColumnAlignment(helpOutput: string): void {
  const columns = getDescriptionColumns(helpOutput);
  const uniqueColumns = new Set(columns);
  if (columns.length > 0 && !columns.includes(-1) && uniqueColumns.size === 1) {
    pass(`All option descriptions begin at column ${columns[0]}`);
  } else {
    fail(`Option description columns differ: ${columns.join(', ')}`);
  }
}

function runTest2(): void {
  console.log(chalk.bold('Test 2: help option descriptions are column-aligned'));
  try {
    const helpOutput = run('yarn start issue:generate -h');
    verifyColumnAlignment(helpOutput);
  } catch (error: any) {
    fail(`Alignment check failed: ${error.message}`);
  }
}

function verifyLineLength(helpOutput: string): void {
  const overlongLines = helpOutput
    .split('\n')
    .map((line, index) => ({ line, index: index + 1 }))
    .filter(({ line }) => line.length > 80);
  if (overlongLines.length === 0) {
    pass('No help lines exceed 80 characters');
  } else {
    fail(
      `Found overlong help lines: ${overlongLines.map(({ index, line }) => `${index}:${line.length}`).join(', ')}`
    );
  }
}

function runTest3(): void {
  console.log(chalk.bold('Test 3: help lines stay within 80 characters'));
  try {
    const helpOutput = run('yarn start issue:generate -h');
    verifyLineLength(helpOutput);
  } catch (error: any) {
    fail(`80-column check failed: ${error.message}`);
  }
}

const REQUIRED_ISSUE_COMMANDS = [
  'issue:fetch',
  'issue:plan',
  'issue:review',
  'issue:create',
  'issue:generate',
  'issue:commit',
  'issue:pr',
  'issue:implement',
];

function findMissingMarkers(readme: string, commands: string[]): string[] {
  return commands.filter(
    commandName =>
      !readme.includes(`<!-- BEGIN GENERATED COMMAND DOCS: ${commandName} -->`)
      || !readme.includes(`<!-- END GENERATED COMMAND DOCS: ${commandName} -->`)
  );
}

function verifyReadmeMarkers(readme: string): void {
  const missingBlocks = findMissingMarkers(readme, REQUIRED_ISSUE_COMMANDS);
  if (missingBlocks.length === 0) {
    pass('README contains all generated issue command doc markers');
  } else {
    fail(`README is missing generated markers for: ${missingBlocks.join(', ')}`);
  }
}

function runTest4(): void {
  console.log(chalk.bold('Test 4: README contains generated issue command doc blocks'));
  try {
    const readme = fs.readFileSync(readmePath, 'utf8');
    verifyReadmeMarkers(readme);
  } catch (error: any) {
    fail(`README verification failed: ${error.message}`);
  }
}

function runTest5(): void {
  console.log(chalk.bold('Test 5: generated docs sync is idempotent'));
  try {
    const firstSync = run('yarn generated-docs:sync');
    const secondSync = run('yarn generated-docs:sync');
    if (firstSync.includes('help:catalog') && secondSync.includes('README command docs already up to date.')) {
      pass('generated-docs:sync runs and becomes stable on the second pass');
    } else {
      fail('generated-docs:sync did not behave idempotently');
    }
  } catch (error: any) {
    fail(`generated-docs:sync failed: ${error.stdout?.toString() || error.stderr?.toString() || error.message}`);
  }
}

async function main(): Promise<void> {
  console.log(chalk.bold.cyan('\n🧪 issue help/doc sync smoke test\n'));

  runTest1();
  runTest2();
  runTest3();
  runTest4();
  runTest5();

  console.log(chalk.bold('\nSummary'));
  console.log(`  Passed: ${counts.passed}`);
  console.log(`  Failed: ${counts.failed}`);

  if (counts.failed > 0) {
    process.exit(1);
  }
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
