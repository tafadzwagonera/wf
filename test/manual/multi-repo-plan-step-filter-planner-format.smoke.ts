/**
 * Smoke test: filterStepsForRepo and resolveAssessedSteps handle the planner em-dash format
 *
 * Run: nr test:manual multi-repo-plan-step-filter-planner-format.smoke.ts
 *
 * Scenario: The planner emits steps as '<repo> — in src/path/file.ts ...' (em-dash),
 * not '<repo>/src/path/file.ts ...' (slash-delimited). The old regex required a leading
 * '<repo>/' segment and never matched planner-format steps, so:
 *   - filterStepsForRepo always treated planner-format steps as generic
 *   - resolveAssessedSteps always returned [] in multi-repo mode → silent skip
 * REPO_RELATIVE_PATH_PATTERN (/\b(?:src|test|lib|app)\//i) now matches the bare src/
 * segment. multi-repo-filtering.smoke.ts already covers the legacy slash-delimited
 * format; this test covers the em-dash format exclusively.
 *
 * Verify:
 *   1. filterStepsForRepo keeps an em-dash step that references this repo's files
 *   2. filterStepsForRepo excludes an em-dash step that references another repo's files
 *   3. filterStepsForRepo treats 'src-notes' (no trailing slash) as a generic step
 *   4. resolveAssessedSteps returns the em-dash step in multi-repo mode
 *   5. resolveAssessedSteps returns [] when no step has a src/|test/|lib/|app/ segment
 */

import chalk from 'chalk';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../../src/app.module';
import { ImplementerAgent } from '../../src/agents/implementer.agent';
import { createReporter } from './support/reporter';

const { counts, pass, fail } = createReporter();

function checkEmDashStepKept(filterSteps: (steps: string[], files: string[], repo: string) => string[]): void {
  const result: string[] = filterSteps(
    ['api-gw — in src/x.ts fix', 'Run tests'],
    ['api-gw/src/x.ts'],
    'api-gw',
  );
  if (result.length === 2 && result.includes('api-gw — in src/x.ts fix') && result.includes('Run tests')) {
    pass("filterStepsForRepo keeps em-dash step referencing this repo's stripped path and generic step");
  } else {
    fail('unexpected result for em-dash step matching this repo', JSON.stringify(result));
  }
}

function checkEmDashStepExcluded(filterSteps: (steps: string[], files: string[], repo: string) => string[]): void {
  const result: string[] = filterSteps(
    ['api-gw — in src/x.ts fix'],
    ['shop/src/cart.ts'],
    'shop',
  );
  if (result.length === 0) {
    pass("filterStepsForRepo excludes em-dash step that does not reference shop's files");
  } else {
    fail('expected empty result when em-dash step references a different repo', JSON.stringify(result));
  }
}

function checkSrcNotesIsGeneric(filterSteps: (steps: string[], files: string[], repo: string) => string[]): void {
  const result: string[] = filterSteps(
    ['update docs/src-notes.md'],
    ['api-gw/src/x.ts'],
    'api-gw',
  );
  if (result.length === 1 && result[0] === 'update docs/src-notes.md') {
    pass("filterStepsForRepo treats 'src-notes' (no trailing slash) as a generic step");
  } else {
    fail("expected 'update docs/src-notes.md' to be kept as a generic step", JSON.stringify(result));
  }
}

function checkResolvedAssessedInMultiRepo(
  resolveAssessed: (steps: string[], opts: { additionalRepoDirs: string[] }) => string[],
): void {
  const result: string[] = resolveAssessed(
    ['api-gw — in src/x.ts add endpoint', 'Run tests'],
    { additionalRepoDirs: ['/tmp/repo-b'] },
  );
  if (result.length === 1 && result[0] === 'api-gw — in src/x.ts add endpoint') {
    pass('resolveAssessedSteps returns the em-dash step and excludes the generic step');
  } else {
    fail('unexpected assessedSteps result for em-dash steps', JSON.stringify(result));
  }
}

function checkResolvedAssessedEmpty(
  resolveAssessed: (steps: string[], opts: { additionalRepoDirs: string[] }) => string[],
): void {
  const result: string[] = resolveAssessed(
    ['Run tests', 'Update CHANGELOG'],
    { additionalRepoDirs: ['/tmp/repo-b'] },
  );
  if (result.length === 0) {
    pass('resolveAssessedSteps returns [] when no step has a src/|test/|lib/|app/ segment');
  } else {
    fail('expected [] when all steps are generic', JSON.stringify(result));
  }
}

function runScenarios(app: { get(token: any): any }): void {
  const agent = app.get(ImplementerAgent);
  const filterSteps = agent.filterStepsForRepo.bind(agent);
  const resolveAssessed = agent.resolveAssessedSteps.bind(agent);
  checkEmDashStepKept(filterSteps);
  checkEmDashStepExcluded(filterSteps);
  checkSrcNotesIsGeneric(filterSteps);
  checkResolvedAssessedInMultiRepo(resolveAssessed);
  checkResolvedAssessedEmpty(resolveAssessed);
}

function printResults(): void {
  console.log(`\n${counts.passed} passed, ${counts.failed} failed`);
  if (counts.failed > 0) process.exit(1);
}

async function main(): Promise<void> {
  console.log(chalk.bold.cyan('\nSmoke: filterStepsForRepo and resolveAssessedSteps — planner em-dash format\n'));
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error'] });
  try {
    runScenarios(app);
  } finally {
    await app.close();
  }
  printResults();
}

main().catch(err => {
  console.error(chalk.red(`\nFAILED: ${err.message}\n`));
  process.exit(1);
});
