/**
 * Manual smoke test: issue:review help examples are consistent.
 *
 * Run: nr test:manual issue-review-help-examples.smoke.ts
 *
 * Verifies:
 *   1. No example command uses `yarn start` — all must use `wf`
 *   2. No duplicate example commands exist in the examples array
 *   3. No catalog example references `yarn start`
 *
 * A prior "help catalog matches registry examples" check was removed from
 * this file: command-docs.registry.spec.ts's "COMMAND_DOCS registry<->catalog
 * equality" describe block already asserts exact equality (not just
 * missing/extra diffing) for every registry key, including issue:review, on
 * every `yarn test` run.
 */

import * as path from 'node:path';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../../src/app.module';
import { getCommandHelpCatalog } from '../../src/bootstrap/help-catalog-parser';
import { COMMAND_DOCS } from '../../src/common/docs/command-docs.registry';
import { createReporter, summarise } from './support/reporter';

const { counts, pass, fail } = createReporter();

function checkNoYarnStartInExamples(): void {
  console.log('Test 1: No example uses yarn start');
  const exampleCommandMatches = COMMAND_DOCS['issue:review'].examples.map(e => e.command);
  const yarnStartExamples = exampleCommandMatches.filter(cmd => cmd.includes('yarn start'));
  if (yarnStartExamples.length === 0) pass('All example commands use wf, not yarn start');
  else fail(`Found yarn start in examples: ${yarnStartExamples.join('; ')}`);
}

function checkNoDuplicateExamples(): void {
  console.log('Test 2: No duplicate example commands');
  const exampleCommandMatches = COMMAND_DOCS['issue:review'].examples.map(e => e.command);
  const seen = new Set<string>();
  const duplicates: string[] = [];
  for (const cmd of exampleCommandMatches) {
    if (seen.has(cmd)) duplicates.push(cmd);
    seen.add(cmd);
  }
  if (duplicates.length === 0) pass('No duplicate example commands');
  else fail(`Duplicate examples: ${duplicates.join('; ')}`);
}

function checkCatalogExamples(): void {
  console.log('Test 3: Catalog examples never reference yarn start');
  const catalog = getCommandHelpCatalog(path.join(__dirname, '../../src/commands'));
  const reviewEntry = catalog['issue:review'];
  if (!reviewEntry) {
    fail('issue:review not found in help catalog');
    return;
  }
  const catalogYarnStart = (reviewEntry.examples ?? []).filter(e => e.command.includes('yarn start'));
  if (catalogYarnStart.length === 0) pass('Catalog examples all use wf');
  else fail(`Catalog has yarn start: ${catalogYarnStart.map(e => e.command).join('; ')}`);
}

async function main(): Promise<void> {
  console.log('Testing issue:review help examples\n');
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error'] });
  try {
    checkNoYarnStartInExamples();
    checkNoDuplicateExamples();
    checkCatalogExamples();
  } finally {
    await app.close();
  }
  summarise(counts);
}

main().catch(error => {
  console.error(`Smoke test failed: ${error.message}`);
  process.exit(1);
});
