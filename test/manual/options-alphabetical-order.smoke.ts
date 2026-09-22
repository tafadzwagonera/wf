/**
 * Manual Test: CLI options alphabetical order smoke test
 *
 * Run: nr test:manual options-alphabetical-order.smoke.ts
 *
 * Verifies:
 *   1. Help catalog options for every command are in alphabetical order by long flag name.
 *   2. Source @Option() decorators appear in alphabetical order by long flag name.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import chalk from 'chalk';
import { createReporter, summarise } from './support/reporter';

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

function findUnsortedFlags(flagsList: string[], name: string, unsorted: string[]): void {
  if (flagsList.length < 2) return;
  const sorted = [...flagsList].sort();
  if (JSON.stringify(flagsList) !== JSON.stringify(sorted)) unsorted.push(`${name}: got [${flagsList.join(', ')}], expected [${sorted.join(', ')}]`);
}

function checkCatalogOptionsAlphabetical(): void {
  try {
    const catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
    const unsorted: string[] = [];
    for (const [commandName, entry] of Object.entries<any>(catalog)) {
      if (!entry.options || entry.options.length < 2) continue;
      findUnsortedFlags(entry.options.map((opt: any) => extractLongFlag(opt.flags)), commandName, unsorted);
    }
    if (unsorted.length === 0) pass('All commands have options in alphabetical order in the help catalog');
    else fail(`Commands with unsorted options:\n    ${unsorted.join('\n    ')}`);
  } catch (error: any) {
    fail(`Catalog check failed: ${error.message}`);
  }
}

function checkSourceDecoratorsAlphabetical(): void {
  try {
    const commandFiles = fs.readdirSync(commandsDir).filter(f => f.endsWith('.command.ts') && !f.endsWith('.spec.ts'));
    const unsorted: string[] = [];
    for (const fileName of commandFiles) {
      const source = fs.readFileSync(path.join(commandsDir, fileName), 'utf8');
      const flagMatches = Array.from(source.matchAll(/@Option\(\{\s*flags:\s*'([^']+)'/g));
      findUnsortedFlags(flagMatches.map(m => extractLongFlag(m[1])), fileName, unsorted);
    }
    if (unsorted.length === 0) pass('All command source files have @Option() decorators in alphabetical order');
    else fail(`Files with unsorted @Option() decorators:\n    ${unsorted.join('\n    ')}`);
  } catch (error: any) {
    fail(`Source check failed: ${error.message}`);
  }
}

async function main(): Promise<void> {
  console.log(chalk.bold.cyan('\n🧪 CLI options alphabetical order smoke test\n'));
  console.log(chalk.bold('Test 1: help catalog options are alphabetically ordered'));
  checkCatalogOptionsAlphabetical();
  console.log(chalk.bold('Test 2: source @Option() decorators are alphabetically ordered'));
  checkSourceDecoratorsAlphabetical();
  summarise(counts);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
