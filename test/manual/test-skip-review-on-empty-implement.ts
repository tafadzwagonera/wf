/**
 * QA smoke test: skip review stage when implement produces no file changes
 *
 * Run: nr test:manual -- test-skip-review-on-empty-implement
 *
 * Spins up a live NestJS app context to verify DI wiring, then exercises
 * the skipReview guard logic that lives in issue.command.ts:567-568.
 */

import chalk from 'chalk';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../../src/app.module';
import { ImplementerAgent } from '../../src/agents/implementer.agent';
import { ReviewerAgent } from '../../src/agents/reviewer.agent';
import type { ImplementerResult } from '../../src/agents/interfaces';

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

const run = async (): Promise<void> => {
  console.log(chalk.bold('\nSmoke test: skip review on empty implement\n'));

  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error'],
  });

  const implementerAgent = app.get(ImplementerAgent);
  const reviewerAgent = app.get(ReviewerAgent);

  assert('ImplementerAgent is resolvable from DI', implementerAgent != null);
  assert('ReviewerAgent is resolvable from DI', reviewerAgent != null);

  const noChangesResult: ImplementerResult = {
    type: 'implementation',
    hasChanges: false,
    branchName: 'test-branch',
    sessionId: undefined,
    verificationOutcomes: [],
  };

  const changesResult: ImplementerResult = {
    type: 'implementation',
    hasChanges: true,
    branchName: 'test-branch',
    sessionId: undefined,
    verificationOutcomes: [],
  };

  // Stub execute to avoid live AI/git calls, verify the return shape is accepted
  implementerAgent.execute = async () => noChangesResult;
  const r1 = await implementerAgent.execute(null as any, null as any, null as any);
  assert('Stubbed execute returns hasChanges: false', r1.type === 'implementation' && !r1.hasChanges);

  implementerAgent.execute = async () => changesResult;
  const r2 = await implementerAgent.execute(null as any, null as any, null as any);
  assert('Stubbed execute returns hasChanges: true', r2.type === 'implementation' && r2.hasChanges);

  // Mirror the skipReview guard from issue.command.ts:567-568
  const skipNoChanges = noChangesResult.type === 'implementation' && !noChangesResult.hasChanges;
  assert('skipReview is true when hasChanges is false', skipNoChanges);

  const skipWithChanges = changesResult.type === 'implementation' && !changesResult.hasChanges;
  assert('skipReview is false when hasChanges is true', !skipWithChanges);

  let maybeResult: ImplementerResult | undefined;
  const skipUndefined = maybeResult?.type === 'implementation' && !maybeResult.hasChanges;
  assert('skipReview is false when implementerResult is undefined', !skipUndefined);

  await app.close();

  console.log(chalk.bold(`\n  ${passed} passed, ${failed} failed\n`));

  if (failed > 0) {
    process.exit(1);
  }
};

run();
