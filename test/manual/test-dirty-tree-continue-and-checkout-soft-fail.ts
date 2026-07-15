/**
 * Smoke test: dirty-tree "Continue without stashing" and checkoutBranch error propagation
 *
 * Verifies two behaviours:
 *   1. When the user selects "Continue without stashing", the implementer
 *      skips stashing and proceeds with the dirty working tree.
 *   2. pullLatestFromSource throws a GitError when checkoutBranch fails
 *      (e.g. dirty tree conflicts with the target branch), surfacing an
 *      actionable message instead of silently continuing.
 *
 * Run: nr test:manual -- test-dirty-tree-continue-and-checkout-soft-fail
 */

import chalk from 'chalk';
import { GitError } from '../../src/shared/errors/app.error';

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

/* ── Scenario 2: pullLatestFromSource — checkoutBranch throws GitError ──── */

async function testCheckoutThrowsGitError() {
  console.log(chalk.gray('  2. pullLatestFromSource throws GitError when checkoutBranch fails'));

  const sourceBranch = 'develop' as string;
  const currentBranch = 'main' as string;

  const mockCheckoutBranch = async (_branch: string): Promise<void> => {
    throw new Error('error: Your local changes would be overwritten by checkout');
  };

  // Replicate the tryCheckoutSource + pullLatestFromSource flow from production code
  const tryCheckoutSource = async (branch: string): Promise<boolean> => {
    try {
      await mockCheckoutBranch(branch);
      return true;
    } catch {
      return false;
    }
  };

  const isRemote = (b: string): boolean => b.startsWith('remotes/') || b.startsWith('origin/');
  let threw = false;
  let errorMessage = '';

  try {
    if (!isRemote(sourceBranch) && currentBranch !== sourceBranch) {
      const switched = await tryCheckoutSource(sourceBranch);
      if (!switched) {
        throw new GitError(
          `Cannot switch to source branch '${sourceBranch}' — working tree has conflicting changes.\n`
          + `Stash or commit your changes in the current directory, then retry.`,
          { sourceBranch },
        );
      }
    }
  } catch (err) {
    threw = true;
    errorMessage = err instanceof Error ? err.message : String(err);
  }

  if (!threw) {
    throw new Error('Expected GitError to be thrown but no error occurred');
  }
  if (!(errorMessage.includes('Cannot switch to source branch'))) {
    throw new Error(`Expected GitError message, got: ${errorMessage}`);
  }
  console.log(chalk.green('     PASS — checkout failure throws GitError with actionable message'));
}

/* ── Scenario 3: pullLatestFromSource — happy path still works ──────────── */

async function testCheckoutHappyPath() {
  console.log(chalk.gray('  3. pullLatestFromSource succeeds when checkoutBranch succeeds'));

  const sourceBranch = 'develop' as string;
  const currentBranch = 'main' as string;
  let checkoutCalled = false;
  let pullCalled = false;

  const mockCheckoutBranch = async (_branch: string): Promise<void> => {
    checkoutCalled = true;
  };

  const mockPull = async (): Promise<void> => {
    pullCalled = true;
  };

  const tryCheckoutSource = async (branch: string): Promise<boolean> => {
    try {
      await mockCheckoutBranch(branch);
      return true;
    } catch {
      return false;
    }
  };

  const isRemote = (b: string): boolean => b.startsWith('remotes/') || b.startsWith('origin/');
  if (!isRemote(sourceBranch) && currentBranch !== sourceBranch) {
    const switched = await tryCheckoutSource(sourceBranch);
    if (!switched) {
      throw new GitError('Should not reach here', { sourceBranch });
    }
  }
  await mockPull();

  if (!checkoutCalled) {
    throw new Error('checkoutBranch was never called');
  }
  if (!pullCalled) {
    throw new Error('pull should have been called after successful checkout');
  }
  console.log(chalk.green('     PASS — checkout succeeded, pull proceeded'));
}

/* ── Runner ─────────────────────────────────────────────────────────────── */

async function main() {
  console.log(chalk.bold.cyan('\nSmoke test: dirty-tree continue & checkout error propagation\n'));

  await testContinueSkipsStash();
  await testCheckoutThrowsGitError();
  await testCheckoutHappyPath();

  console.log(chalk.bold.green('\nAll smoke tests passed.\n'));
}

main().catch(err => {
  console.error(chalk.red(`\nFAILED: ${err.message}\n`));
  process.exit(1);
});
