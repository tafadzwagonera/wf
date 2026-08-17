/**
 * Manual smoke test: buildPreReviewContext live side effects
 *
 * Run: nr test:manual -- test-build-pre-review-context
 *
 * Tests four live behaviours of buildPreReviewContext:
 *   1. repoDir absent → returns base context unchanged, no enrichment.
 *   2. repoDir present, no commentRef → appends conventions (no live verification run).
 *   3. repoDir present, no commentRef, no ticketKey → resolveVerificationSummary
 *      called with '' — must complete without throwing regardless of cache state.
 *   4. repoDir present, commentRef set → runPreReviewVerification runs; output
 *      (✓/✗ markers or empty string) is appended before conventions.
 *
 * No AI calls are made. All tests operate against the wf repo itself.
 */

import chalk from 'chalk';
import { buildPreReviewContext } from '../../src/shared/utils/build-pre-review-context';

let passed = 0;
let failed = 0;

const pass = (msg: string): void => {
  console.log(chalk.green(`  ✓ ${msg}`));
  passed++;
};
const fail = (msg: string, detail?: string): void => {
  console.log(chalk.red(`  ✗ ${msg}`));
  if (detail) console.log(chalk.red(`    ${detail}`));
  failed++;
};
const assert = (label: string, condition: boolean, detail?: string): void =>
  condition ? pass(label) : fail(label, detail);

async function main(): Promise<void> {
  console.log(chalk.bold('\nSmoke test: buildPreReviewContext live side effects\n'));

  const repoDir = process.cwd();
  const BASE = 'current repository changes: wf';

  console.log(chalk.gray('  1. repoDir absent → base context unchanged'));
  {
    let result: string | undefined;
    let threw = false;
    try {
      result = await buildPreReviewContext(
        { context: BASE, commentRef: 'https://bitbucket.org/x/y/pull-requests/1' },
        { ticketKey: 'TST-1', silent: true }
      );
    } catch {
      threw = true;
    }
    assert('does not throw', !threw);
    assert(
      'returns base context exactly when repoDir is absent',
      result === BASE,
      `Got: ${result}`
    );
  }

  console.log(chalk.gray('  2. repoDir present, no commentRef → conventions section appended'));
  {
    let result: string | undefined;
    let threw = false;
    try {
      result = await buildPreReviewContext(
        { context: BASE, repoDir },
        { silent: true }
      );
    } catch (err: any) {
      threw = true;
      fail('threw unexpectedly', err?.message);
    }
    assert('does not throw', !threw);
    if (!threw && result !== undefined) {
      assert(
        'result is longer than base context (enrichment appended)',
        result.length > BASE.length,
        `result length ${result.length} vs base ${BASE.length}`
      );
      const hasConventions = /linter|formatter|language|typescript|eslint|prettier|biome/i.test(result);
      assert(
        'conventions section contains expected keywords',
        hasConventions,
        `Conventions keywords not found in:\n${result}`
      );
      assert(
        'base context is still present in result',
        result.startsWith(BASE),
        `Result did not start with base context: ${result.slice(0, 100)}`
      );
    }
  }

  console.log(chalk.gray('  3. no ticketKey → resolveVerificationSummary(\'\') completes without throwing'));
  {
    let threw = false;
    const start = Date.now();
    try {
      await buildPreReviewContext(
        { context: BASE, repoDir },
        { silent: true }  // ticketKey intentionally absent
      );
    } catch {
      threw = true;
    }
    const elapsed = Date.now() - start;
    assert('does not throw with absent ticketKey', !threw);
    assert(
      'completes within 10 seconds (no stall from git subprocess)',
      elapsed < 10_000,
      `Took ${elapsed}ms`
    );
  }

  console.log(chalk.gray('  4. commentRef present → runPreReviewVerification executes (✓/✗ markers or empty)'));
  {
    let result: string | undefined;
    let threw = false;
    try {
      result = await buildPreReviewContext(
        { context: BASE, repoDir, commentRef: 'https://bitbucket.org/x/y/pull-requests/99' },
        { silent: true }
      );
    } catch (err: any) {
      threw = true;
      fail('threw unexpectedly', err?.message);
    }
    assert('does not throw', !threw);
    if (!threw && result !== undefined) {
      assert(
        'result is longer than base context (enrichment from live verification + conventions)',
        result.length > BASE.length,
        `result length ${result.length} vs base ${BASE.length}`
      );
      const hasVerification = /✓|✗|pre-review verification|lint|typecheck|test/i.test(result);
      assert(
        'verification markers or script names present (or conventions section without scripts)',
        hasVerification || /linter|formatter|language/i.test(result),
        `Neither verification markers nor conventions found in:\n${result.slice(0, 300)}`
      );
    }
  }

  console.log(chalk.bold(`\n  ${passed} passed, ${failed} failed\n`));
  if (failed > 0) process.exit(1);
}

main();
