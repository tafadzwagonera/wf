/**
 * Smoke test: mergeImplementResult accumulates hasChanges across repos
 *
 * Verifies:
 *   1. anyHasChanges stays true after a no-changes repo follows a with-changes repo
 *   2. finalizeImplementResult stamps the last result with the accumulated flag
 *   3. earlyReturn is always false from finalizeImplementResult
 *   4. When all repos have no changes the final hasChanges is false
 *   5. An undefined result passes through finalizeImplementResult unchanged
 *
 * Run: nr test:manual implement-result-accumulation.smoke.ts
 */

import chalk from 'chalk';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../../src/app.module';
import { IssueCommand } from '../../src/commands/issue.command';
import type { ImplementerResult } from '../../src/agents/interfaces';
import { createReporter, summarise } from './support/reporter';

interface MergeResult {
  anyHasChanges: boolean;
  implementerResult?: ImplementerResult;
}
interface FinalizeResult {
  earlyReturn: boolean;
  implementerResult?: ImplementerResult;
}
type MergeFn = (result: ImplementerResult | undefined, acc: boolean) => MergeResult;
type FinalizeFn = (result: ImplementerResult | undefined, acc: boolean) => FinalizeResult;

const { counts, pass, fail } = createReporter();
const assert = (label: string, condition: boolean): void =>
  condition ? pass(label) : fail(label);

const makeResult = (hasChanges: boolean): ImplementerResult => ({
  type: 'implementation',
  hasChanges,
  branchName: 'fix/WBP-1',
  sessionId: undefined,
  verificationOutcomes: [],
});

async function bootstrapCommand(): Promise<{
  app: any;
  mergeImplementResult: MergeFn;
  finalizeImplementResult: FinalizeFn;
}> {
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error'] });
  const command = app.get(IssueCommand);
  return {
    app,
    mergeImplementResult: (command as any).mergeImplementResult.bind(command),
    finalizeImplementResult: (command as any).finalizeImplementResult.bind(command),
  };
}

function checkChangesRepoSetsAccumulator(merge: MergeFn): void {
  console.log(chalk.bold('  1. changes repo sets accumulator'));
  const m1 = merge(makeResult(true), false);
  assert('anyHasChanges becomes true', m1.anyHasChanges === true);
  assert(
    'implementerResult passed through',
    m1.implementerResult?.type === 'implementation' && m1.implementerResult.hasChanges === true
  );
}

function checkNoChangesDoesNotResetAccumulator(merge: MergeFn): void {
  console.log(chalk.bold('\n  2. no-changes repo does not reset accumulator'));
  const m2 = merge(makeResult(false), true);
  assert('anyHasChanges remains true', m2.anyHasChanges === true);
}

function checkFinalizeStampsAccumulatedFlag(finalize: FinalizeFn): void {
  console.log(chalk.bold('\n  3. finalize stamps accumulated hasChanges'));
  const finalized = finalize(makeResult(false), true);
  assert(
    'hasChanges stamped as true',
    finalized.implementerResult?.type === 'implementation' && finalized.implementerResult.hasChanges === true
  );
  assert('earlyReturn is false', finalized.earlyReturn === false);
}

function checkAllNoChangesYieldsFalse(merge: MergeFn, finalize: FinalizeFn): void {
  console.log(chalk.bold('\n  4. all repos no-changes → final false'));
  const mNone1 = merge(makeResult(false), false);
  const mNone2 = merge(makeResult(false), mNone1.anyHasChanges);
  const finalizedNone = finalize(mNone2.implementerResult, mNone2.anyHasChanges);
  assert(
    'final hasChanges is false',
    finalizedNone.implementerResult?.type === 'implementation' && finalizedNone.implementerResult.hasChanges === false
  );
}

function checkUndefinedResultPassesThrough(finalize: FinalizeFn): void {
  console.log(chalk.bold('\n  5. undefined result passes through'));
  const finalizedUndef = finalize(undefined, false);
  assert('implementerResult is undefined', finalizedUndef.implementerResult === undefined);
  assert('earlyReturn is false', finalizedUndef.earlyReturn === false);
}

async function main(): Promise<void> {
  console.log(chalk.bold.cyan('\nSmoke test: mergeImplementResult / finalizeImplementResult accumulation\n'));
  const { app, mergeImplementResult, finalizeImplementResult } = await bootstrapCommand();
  try {
    checkChangesRepoSetsAccumulator(mergeImplementResult);
    checkNoChangesDoesNotResetAccumulator(mergeImplementResult);
    checkFinalizeStampsAccumulatedFlag(finalizeImplementResult);
    checkAllNoChangesYieldsFalse(mergeImplementResult, finalizeImplementResult);
    checkUndefinedResultPassesThrough(finalizeImplementResult);
  } finally {
    await app.close();
  }
  summarise(counts);
}

main().catch(error => {
  console.error(chalk.red(`\nFAILED: ${error.message}\n`));
  process.exit(1);
});
