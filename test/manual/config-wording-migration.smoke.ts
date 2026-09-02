/**
 * Manual Test: config-wording migration smoke test
 *
 * Run: nr test:manual -- test-config-wording-migration
 *
 * Verifies:
 *   1. `issue:generate -h` says "default from config" (not "from env").
 *   2. `issue:create -h` says "default from config" (not "from env").
 *   3. Help catalog JSON contains no "from env" references.
 *   4. README contains no "from env" or "from environment" references in option tables.
 *   5. Error messages reference `wf.config.*` instead of env-var names.
 */

import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import chalk from 'chalk';
import { createReporter } from './support/reporter';

const repoRoot = path.join(__dirname, '..', '..');
const catalogPath = path.join(repoRoot, 'docs', 'commands-help.catalog.json');
const readmePath = path.join(repoRoot, 'README.md');

const run = (command: string): string =>
  execSync(command, {
    cwd: repoRoot,
    encoding: 'utf-8',
    stdio: 'pipe',
  });

/**
 * Collapse consecutive whitespace so wrapped help lines can be matched as a single phrase.
 *
 * @param text Raw CLI output that may contain line-wrapped phrases
 * @returns Text with all whitespace runs collapsed to a single space
 */
const collapseWhitespace = (text: string): string => text.replaceAll(/\s+/g, ' ');

const { counts, pass, fail } = createReporter();

async function main(): Promise<void> {
  console.log(chalk.bold.cyan('\n🧪 config-wording migration smoke test\n'));

  console.log(chalk.bold('Test 1: issue:generate help says "default from config"'));
  try {
    const helpOutput = run('yarn start issue:generate -h');
    const normalized = collapseWhitespace(helpOutput);
    if (normalized.includes('default from config')) {
      pass('issue:generate help uses "default from config"');
    } else {
      fail('issue:generate help still contains stale wording');
    }

    if (normalized.includes('default from env')) {
      fail('issue:generate help still references "from env"');
    } else {
      pass('issue:generate help has no "from env" references');
    }
  } catch (error: any) {
    fail(`issue:generate help invocation failed: ${error.message}`);
    counts.failed += 1;
  }

  console.log(chalk.bold('Test 2: issue:create help says "default from config"'));
  try {
    const helpOutput = run('yarn start issue:create -h');
    const normalized = collapseWhitespace(helpOutput);
    if (normalized.includes('default from config')) {
      pass('issue:create help uses "default from config"');
    } else {
      fail('issue:create help still contains stale wording');
    }

    if (normalized.includes('default from env')) {
      fail('issue:create help still references "from env"');
    } else {
      pass('issue:create help has no "from env" references');
    }
  } catch (error: any) {
    fail(`issue:create help invocation failed: ${error.message}`);
    counts.failed += 1;
  }

  console.log(chalk.bold('Test 3: help catalog JSON has no "from env" references'));
  try {
    const catalog = fs.readFileSync(catalogPath, 'utf8');
    if (catalog.includes('from env')) {
      fail('Help catalog still contains "from env"');
    } else {
      pass('Help catalog is free of "from env" references');
    }
  } catch (error: any) {
    fail(`Catalog read failed: ${error.message}`);
  }

  console.log(chalk.bold('Test 4: README option tables have no "from env"/"from environment"'));
  try {
    const readme = fs.readFileSync(readmePath, 'utf8');
    const stalePatterns = ['default from env', 'from environment'];
    const found = stalePatterns.filter(pattern => readme.includes(pattern));

    if (found.length === 0) {
      pass('README is free of stale env-var wording');
    } else {
      fail(`README still contains: ${found.join(', ')}`);
    }
  } catch (error: any) {
    fail(`README read failed: ${error.message}`);
  }

  console.log(chalk.bold('Test 5: source error messages reference wf.config.*'));
  try {
    const files = [
      'src/commands/issue-generate.command.ts',
      'src/commands/issue-implement.command.ts',
      'src/workflows/stages/fetch-stage.service.ts',
    ];
    let allGood = true;

    for (const filePath of files) {
      const content = fs.readFileSync(path.join(repoRoot, filePath), 'utf8');
      if (content.includes('set ATLASSIAN_BITBUCKET_WORKSPACE')) {
        fail(`${filePath} still references ATLASSIAN_BITBUCKET_WORKSPACE`);
        allGood = false;
      }

      if (!content.includes('wf.config.*')) {
        fail(`${filePath} does not reference wf.config.*`);
        allGood = false;
      }
    }

    if (allGood) {
      pass('All error messages reference wf.config.* correctly');
    } else {
      counts.failed += 1;
    }
  } catch (error: any) {
    fail(`Source file check failed: ${error.message}`);
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
