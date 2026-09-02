/**
 * Manual Test: CLI options alphabetical order smoke test
 *
 * Run: nr test:manual -- test-options-alphabetical-order
 *
 * Verifies:
 *   1. Help catalog options for every command are in alphabetical order by long flag name.
 *   2. Source @Option() decorators appear in alphabetical order by long flag name.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import chalk from 'chalk';
import { createReporter } from './support/reporter';

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
  const match = /--([a-z][-a-z]*)/.exec(flags);
  return match ? match[1] : flags;
};

const { counts, pass, fail } = createReporter();

async function main(): Promise<void> {
  console.log(chalk.bold.cyan('\n🧪 CLI options alphabetical order smoke test\n'));

  console.log(chalk.bold('Test 1: help catalog options are alphabetically ordered'));
  try {
    const catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
    const unsorted: string[] = [];

    for (const [commandName, entry] of Object.entries<any>(catalog)) {
      if (!entry.options || entry.options.length < 2) {
        continue;
      }

      const longFlags = entry.options.map((opt: any) => extractLongFlag(opt.flags));
      const sorted = [...longFlags].sort();

      if (JSON.stringify(longFlags) !== JSON.stringify(sorted)) {
        unsorted.push(`${commandName}: got [${longFlags.join(', ')}], expected [${sorted.join(', ')}]`);
      }
    }

    if (unsorted.length === 0) {
      pass('All commands have options in alphabetical order in the help catalog');
    } else {
      fail(`Commands with unsorted options:\n    ${unsorted.join('\n    ')}`);
    }
  } catch (error: any) {
    fail(`Catalog check failed: ${error.message}`);
  }

  console.log(chalk.bold('Test 2: source @Option() decorators are alphabetically ordered'));
  try {
    const commandFiles = fs.readdirSync(commandsDir).filter(f => f.endsWith('.command.ts') && !f.endsWith('.spec.ts'));

    const unsorted: string[] = [];

    for (const fileName of commandFiles) {
      const source = fs.readFileSync(path.join(commandsDir, fileName), 'utf8');
      const flagMatches = Array.from(source.matchAll(/@Option\(\{\s*flags:\s*'([^']+)'/g));

      if (flagMatches.length < 2) {
        continue;
      }

      const longFlags = flagMatches.map(m => extractLongFlag(m[1]));
      const sorted = [...longFlags].sort();

      if (JSON.stringify(longFlags) !== JSON.stringify(sorted)) {
        unsorted.push(`${fileName}: got [${longFlags.join(', ')}], expected [${sorted.join(', ')}]`);
      }
    }

    if (unsorted.length === 0) {
      pass('All command source files have @Option() decorators in alphabetical order');
    } else {
      fail(`Files with unsorted @Option() decorators:\n    ${unsorted.join('\n    ')}`);
    }
  } catch (error: any) {
    fail(`Source check failed: ${error.message}`);
  }

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
