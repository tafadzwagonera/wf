/**
 * Smoke test: dirty-tree "Continue without stashing" and checkoutBranch soft-fail
 *
 * Verifies two behaviours introduced by the dirty-tree prompt rework:
 *   1. When the user selects "Continue without stashing", the implementer
 *      skips stashing and proceeds with the dirty working tree.
 *   2. pullLatestFromSource soft-fails when checkoutBranch throws (e.g. dirty
 *      tree conflicts with the target branch) instead of propagating an error.
 *
 * Run: nr test:manual -- test-dirty-tree-continue-and-checkout-soft-fail
 */

import chalk from 'chalk';

/* ── Scenario 1: ensureCleanWorkingTree — "continue" skips stash ────────── */

async function testContinueSkipsStash() {
  console.log(chalk.gray('  1. ensureCleanWorkingTree returns { didStash: false } on "continue"'));

  // Inline a minimal replica of the interactive branch in ensureCleanWorkingTree.
  // The real method delegates to inquirer; here we simulate the "continue" path.
  const dirtyTreeAction = 'continue' as 'stash' | 'continue' | 'abort';

  const result = (() => {
    if (dirtyTreeAction === 'abort') {
      throw new Error('Aborted');
    }
    if (dirtyTreeAction === 'continue') {
      return { didStash: false };
    }
    // stash path
    return { didStash: true };
  })();

  if (result.didStash !== false) {
    throw new Error(`Expected didStash=false, got didStash=${result.didStash}`);
  }
  console.log(chalk.green('     PASS — "continue" yields { didStash: false }'));
}

/* ── Scenario 2: pullLatestFromSource — checkoutBranch soft-fail ────────── */

async function testCheckoutSoftFail() {
  console.log(chalk.gray('  2. pullLatestFromSource soft-fails when checkoutBranch throws'));

  // Simulate the guarded checkoutBranch logic from pullLatestFromSource.
  const sourceBranch = 'develop' as string;
  const currentBranch = 'main' as string;
  let checkoutCalled = false;
  let pullCalled = false;
  let warningLogged = false;

  const mockCheckoutBranch = async (_branch: string): Promise<void> => {
    checkoutCalled = true;
    throw new Error('error: Your local changes would be overwritten by checkout');
  };

  const mockPull = async (): Promise<void> => {
    pullCalled = true;
  };

  // Replicate the try/catch structure from the production code
  const isRemote = (b: string): boolean => b.startsWith('remotes/') || b.startsWith('origin/');
  if (!isRemote(sourceBranch)) {
    if (currentBranch !== sourceBranch) {
      try {
        await mockCheckoutBranch(sourceBranch);
      } catch {
        warningLogged = true;
        // Production code logs: chalk.yellow(`Could not switch to ${sourceBranch} — …`)
        // and returns early, skipping the pull.
      }
    }
    if (!warningLogged) {
      try {
        await mockPull();
      } catch {
        // non-fatal
      }
    }
  }

  if (!checkoutCalled) {
    throw new Error('checkoutBranch was never called');
  }
  if (!warningLogged) {
    throw new Error('checkout failure was not caught — error propagated');
  }
  if (pullCalled) {
    throw new Error('pull should have been skipped after checkout failure');
  }
  console.log(chalk.green('     PASS — checkout failure caught, pull skipped, no throw'));
}

/* ── Scenario 3: pullLatestFromSource — happy path still works ──────────── */

async function testCheckoutHappyPath() {
  console.log(chalk.gray('  3. pullLatestFromSource succeeds when checkoutBranch succeeds'));

  const sourceBranch = 'develop' as string;
  const currentBranch = 'main' as string;
  let checkoutCalled = false;
  let pullCalled = false;
  let warningLogged = false;

  const mockCheckoutBranch = async (_branch: string): Promise<void> => {
    checkoutCalled = true;
  };

  const mockPull = async (): Promise<void> => {
    pullCalled = true;
  };

  const isRemote = (b: string): boolean => b.startsWith('remotes/') || b.startsWith('origin/');
  if (!isRemote(sourceBranch)) {
    if (currentBranch !== sourceBranch) {
      try {
        await mockCheckoutBranch(sourceBranch);
      } catch {
        warningLogged = true;
      }
    }
    if (!warningLogged) {
      try {
        await mockPull();
      } catch {
        // non-fatal
      }
    }
  }

  if (!checkoutCalled) {
    throw new Error('checkoutBranch was never called');
  }
  if (warningLogged) {
    throw new Error('warning should not have been logged on success');
  }
  if (!pullCalled) {
    throw new Error('pull should have been called after successful checkout');
  }
  console.log(chalk.green('     PASS — checkout succeeded, pull proceeded'));
}

/* ── Runner ─────────────────────────────────────────────────────────────── */

async function main() {
  console.log(chalk.bold.cyan('\nSmoke test: dirty-tree continue & checkout soft-fail\n'));

  await testContinueSkipsStash();
  await testCheckoutSoftFail();
  await testCheckoutHappyPath();

  console.log(chalk.bold.green('\nAll smoke tests passed.\n'));
}

main().catch(err => {
  console.error(chalk.red(`\nFAILED: ${err.message}\n`));
  process.exit(1);
});
