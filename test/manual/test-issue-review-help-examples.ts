/**
 * Manual smoke test: issue:review help examples are consistent.
 *
 * Run: nr test:manual -- test-issue-review-help-examples
 *
 * Verifies:
 *   1. No example command uses `yarn start` — all must use `wf`
 *   2. No duplicate example commands exist in the examples array
 *   3. The generated help catalog matches the source examples
 */

import * as fs from 'fs';
import * as path from 'path';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../../src/app.module';
import { getCommandHelpCatalog } from '../../src/bootstrap/help-catalog-parser';

async function run(): Promise<void> {
  console.log('Testing issue:review help examples\n');

  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error'],
  });

  let passed = 0;
  let failed = 0;

  const pass = (msg: string) => {
    console.log(`  PASS ${msg}`);
    passed++;
  };
  const fail = (msg: string) => {
    console.error(`  FAIL ${msg}`);
    failed++;
  };

  // --- Test 1: Source examples never reference `yarn start` ---
  console.log('Test 1: No example uses yarn start');
  const sourceFile = fs.readFileSync(path.join(__dirname, '../../src/commands/issue-review.command.ts'), 'utf-8');
  const exampleCommandMatches = Array.from(sourceFile.matchAll(/command:\s*'([^']+)'/g)).map(m => m[1]);

  const yarnStartExamples = exampleCommandMatches.filter(cmd => cmd.includes('yarn start'));
  if (yarnStartExamples.length === 0) {
    pass('All example commands use wf, not yarn start');
  } else {
    fail(`Found yarn start in examples: ${yarnStartExamples.join('; ')}`);
  }

  // --- Test 2: No duplicate example commands ---
  console.log('Test 2: No duplicate example commands');
  const seen = new Set<string>();
  const duplicates: string[] = [];
  for (const cmd of exampleCommandMatches) {
    if (seen.has(cmd)) {
      duplicates.push(cmd);
    }
    seen.add(cmd);
  }
  if (duplicates.length === 0) {
    pass('No duplicate example commands');
  } else {
    fail(`Duplicate examples: ${duplicates.join('; ')}`);
  }

  // --- Test 3: Help catalog reflects source examples ---
  console.log('Test 3: Help catalog matches source examples');
  const catalog = getCommandHelpCatalog(path.join(__dirname, '../../src/commands'));
  const reviewEntry = catalog['issue:review'];
  if (!reviewEntry) {
    fail('issue:review not found in help catalog');
  } else {
    const catalogCommands = (reviewEntry.examples ?? []).map(e => e.command);
    const missingFromCatalog = exampleCommandMatches.filter(cmd => !catalogCommands.includes(cmd));
    const extraInCatalog = catalogCommands.filter(cmd => !exampleCommandMatches.includes(cmd));

    if (missingFromCatalog.length === 0 && extraInCatalog.length === 0) {
      pass('Catalog examples match source examples exactly');
    } else {
      if (missingFromCatalog.length > 0) {
        fail(`Missing from catalog: ${missingFromCatalog.join('; ')}`);
      }
      if (extraInCatalog.length > 0) {
        fail(`Extra in catalog: ${extraInCatalog.join('; ')}`);
      }
    }
  }

  // --- Test 4: Catalog examples never reference `yarn start` ---
  console.log('Test 4: Catalog examples never reference yarn start');
  if (reviewEntry) {
    const catalogYarnStart = (reviewEntry.examples ?? []).filter(e => e.command.includes('yarn start'));
    if (catalogYarnStart.length === 0) {
      pass('Catalog examples all use wf');
    } else {
      fail(`Catalog has yarn start: ${catalogYarnStart.map(e => e.command).join('; ')}`);
    }
  }

  // --- Summary ---
  console.log(`\nResults: ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    await app.close();
    process.exit(1);
  }

  console.log('All tests passed!');
  await app.close();
}

run().catch(error => {
  console.error(`Smoke test failed: ${error.message}`);
  process.exit(1);
});
