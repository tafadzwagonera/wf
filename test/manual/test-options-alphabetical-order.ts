/**
 * Manual Test: CLI options alphabetical order smoke test
 *
 * Run: nr test:manual -- test-options-alphabetical-order
 *
 * Verifies:
 *   1. Help catalog options for every command are in alphabetical order by long flag name.
 *   2. Source @Option() decorators appear in alphabetical order by long flag name.
 */

import * as fs from 'fs';
import * as path from 'path';
import chalk from 'chalk';

const repoRoot = path.join(__dirname, '..', '..');
const catalogPath = path.join(repoRoot, 'docs', 'commands-help.catalog.json');
const commandsDir = path.join(repoRoot, 'src', 'commands');

/**
 * Extract the long flag name from a flags string like "-r, --repos <repos...>".
 *
 * @param flags Option flags string
 * @returns The long flag name without dashes (e.g. "repos")
 */
const extractLongFlag = (flags: string): string => {
  const match = flags.match(/--([a-z][-a-z]*)/);
  return match ? match[1] : flags;
};

/**
 * Print a pass result.
 *
 * @param message Human-readable pass message
 * @returns Void
 */
const pass = (message: string): void => {
  console.log(chalk.green(`  ✓ ${message}`));
};

/**
 * Print a failure result.
 *
 * @param message Human-readable failure message
 * @returns Void
 */
const fail = (message: string): void => {
  console.error(chalk.red(`  ✗ ${message}`));
};

async function main() {
  console.log(
    chalk.bold.cyan('\n🧪 CLI options alphabetical order smoke test\n'),
  );

  let passed = 0;
  let failed = 0;

  console.log(
    chalk.bold('Test 1: help catalog options are alphabetically ordered'),
  );
  try {
    const catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
    const unsorted: string[] = [];

    for (const [commandName, entry] of Object.entries<any>(catalog)) {
      if (!entry.options || entry.options.length < 2) {
        continue;
      }

      const longFlags = entry.options.map((opt: any) =>
        extractLongFlag(opt.flags),
      );
      const sorted = [...longFlags].sort();

      if (JSON.stringify(longFlags) !== JSON.stringify(sorted)) {
        unsorted.push(
          `${commandName}: got [${longFlags.join(', ')}], expected [${sorted.join(', ')}]`,
        );
      }
    }

    if (unsorted.length === 0) {
      pass(
        'All commands have options in alphabetical order in the help catalog',
      );
      passed += 1;
    } else {
      fail(`Commands with unsorted options:\n    ${unsorted.join('\n    ')}`);
      failed += 1;
    }
  } catch (error: any) {
    fail(`Catalog check failed: ${error.message}`);
    failed += 1;
  }

  console.log(
    chalk.bold(
      'Test 2: source @Option() decorators are alphabetically ordered',
    ),
  );
  try {
    const commandFiles = fs
      .readdirSync(commandsDir)
      .filter((f) => f.endsWith('.command.ts') && !f.endsWith('.spec.ts'));

    const unsorted: string[] = [];

    for (const fileName of commandFiles) {
      const source = fs.readFileSync(path.join(commandsDir, fileName), 'utf8');
      const flagMatches = Array.from(
        source.matchAll(/@Option\(\{\s*flags:\s*'([^']+)'/g),
      );

      if (flagMatches.length < 2) {
        continue;
      }

      const longFlags = flagMatches.map((m) => extractLongFlag(m[1]));
      const sorted = [...longFlags].sort();

      if (JSON.stringify(longFlags) !== JSON.stringify(sorted)) {
        unsorted.push(
          `${fileName}: got [${longFlags.join(', ')}], expected [${sorted.join(', ')}]`,
        );
      }
    }

    if (unsorted.length === 0) {
      pass(
        'All command source files have @Option() decorators in alphabetical order',
      );
      passed += 1;
    } else {
      fail(
        `Files with unsorted @Option() decorators:\n    ${unsorted.join('\n    ')}`,
      );
      failed += 1;
    }
  } catch (error: any) {
    fail(`Source check failed: ${error.message}`);
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
