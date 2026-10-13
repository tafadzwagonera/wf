/**
 * Smoke test: multi-repo plan step filtering
 *
 * Verifies:
 *   1. filterStepsForRepo excludes steps referencing another repo's files
 *   2. filterStepsForRepo passes all steps through for empty repoName or repoFiles
 *
 * Run: nr test:manual multi-repo-filtering.smoke.ts
 */

import chalk from 'chalk';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../../src/app.module';
import { ImplementerAgent } from '../../src/agents/implementer.agent';

let passed = 0;
let failed = 0;

const assert = (label: string, condition: boolean): void => {
  if (condition) {
    console.log(chalk.green(`  ✓ ${label}`));
    passed++;
  } else {
    console.log(chalk.red(`  ✗ ${label}`));
    failed++;
  }
};

type StepFilter = (steps: string[], files: string[], repo: string) => string[];

function checkCrossRepoStepFiltering(filter: StepFilter): void {
  const steps = [
    'Update repo-a/src/services/booking.mapper.ts',
    'Update cop-nuxt-app/src/services/booking.service.ts',
    'Run verification tests',
  ];
  const result = filter(steps, ['repo-a/src/services/booking.mapper.ts'], 'repo-a');
  assert('keeps step referencing this repo', result.includes('Update repo-a/src/services/booking.mapper.ts'));
  assert('keeps generic step', result.includes('Run verification tests'));
  assert('cross-repo step is excluded (filtered count equals 2)', result.length === 2);
}

function checkPassthroughFiltering(filter: StepFilter): void {
  const steps = ['Step A', 'Step B'];
  assert('passes all steps through for empty repoName', filter(steps, ['src/a.ts'], '').length === 2);
  assert('passes all steps through for empty repoFiles', filter(steps, [], 'repo-a').length === 2);
  const genericSteps = ['Run yarn test', 'Check CI status'];
  assert('generic steps always included', filter(genericSteps, ['repo-a/src/a.ts'], 'repo-a').length === 2);
}

function runFilterStepsForRepoChecks(agent: ImplementerAgent): void {
  console.log(chalk.bold('\n  filterStepsForRepo'));
  const filter = (agent as any).filterStepsForRepo.bind(agent) as StepFilter;
  checkCrossRepoStepFiltering(filter);
  checkPassthroughFiltering(filter);
}

async function main(): Promise<void> {
  console.log(chalk.bold.cyan('\nSmoke test: multi-repo filtering\n'));
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error'],
  });
  try {
    runFilterStepsForRepoChecks(app.get(ImplementerAgent));
    console.log(chalk.bold(`\n  ${passed} passed, ${failed} failed\n`));
    if (failed > 0) process.exit(1);
  } finally {
    await app.close();
  }
}

main().catch(err => {
  console.error(chalk.red(`\nFAILED: ${err.message}\n`));
  process.exit(1);
});
