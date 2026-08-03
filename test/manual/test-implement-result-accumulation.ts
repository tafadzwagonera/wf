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
 * Run: nr test:manual -- test-implement-result-accumulation
 */

import chalk from 'chalk';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../../src/app.module';
import { IssueCommand } from '../../src/commands/issue.command';
import type { ImplementerResult } from '../../src/agents/interfaces';

let passed = 0;
let failed = 0;

const assert = (label: string, condition: boolean): void => {
  if (condition) {
    console.log(chalk.green(`  \u2713 ${label}`));
    passed++;
  } else {
    console.log(chalk.red(`  \u2717 ${label}`));
    failed++;
  }
};

const makeResult = (hasChanges: boolean): ImplementerResult => ({
  type: 'implementation',
  hasChanges,
  branchName: 'fix/WBP-1',
  sessionId: undefined,
  verificationOutcomes: [],
});

async function main() {
  console.log(chalk.bold.cyan('\nSmoke test: mergeImplementResult / finalizeImplementResult accumulation\n'));

  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error'],
  });

  try {
    const command = app.get(IssueCommand);
    const mergeImplementResult = (command as any).mergeImplementResult.bind(command);
    const finalizeImplementResult = (command as any).finalizeImplementResult.bind(command);

    // 1. Repo with changes sets accumulator to true
    console.log(chalk.bold('  1. changes repo sets accumulator'));
    const m1 = mergeImplementResult(makeResult(true), false);
    assert('anyHasChanges becomes true', m1.anyHasChanges === true);
    assert('implementerResult passed through', m1.implementerResult?.hasChanges === true);

    // 2. No-changes repo after a changes repo does NOT reset accumulator
    console.log(chalk.bold('\n  2. no-changes repo does not reset accumulator'));
    const m2 = mergeImplementResult(makeResult(false), true);
    assert('anyHasChanges remains true', m2.anyHasChanges === true);

    // 3. finalizeImplementResult stamps accumulated flag onto last result
    console.log(chalk.bold('\n  3. finalize stamps accumulated hasChanges'));
    const finalized = finalizeImplementResult(makeResult(false), true);
    assert('hasChanges stamped as true', finalized.implementerResult?.hasChanges === true);
    assert('earlyReturn is false', finalized.earlyReturn === false);

    // 4. All repos have no changes → final hasChanges false
    console.log(chalk.bold('\n  4. all repos no-changes → final false'));
    const mNone1 = mergeImplementResult(makeResult(false), false);
    const mNone2 = mergeImplementResult(makeResult(false), mNone1.anyHasChanges);
    const finalizedNone = finalizeImplementResult(mNone2.implementerResult, mNone2.anyHasChanges);
    assert('final hasChanges is false', finalizedNone.implementerResult?.hasChanges === false);

    // 5. undefined result passes through finalizeImplementResult
    console.log(chalk.bold('\n  5. undefined result passes through'));
    const finalizedUndef = finalizeImplementResult(undefined, false);
    assert('implementerResult is undefined', finalizedUndef.implementerResult === undefined);
    assert('earlyReturn is false', finalizedUndef.earlyReturn === false);

    console.log(chalk.bold(`\n  ${passed} passed, ${failed} failed\n`));

    if (failed > 0) {
      process.exit(1);
    }
  } finally {
    await app.close();
  }
}

main().catch(err => {
  console.error(chalk.red(`\nFAILED: ${err.message}\n`));
  process.exit(1);
});
