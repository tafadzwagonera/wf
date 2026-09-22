/**
 * Manual smoke test: buildPreReviewContext live side effects
 *
 * Run: nr test:manual build-pre-review-context.smoke.ts
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
import { createReporter, summarise } from './support/reporter';

const { counts, pass, fail } = createReporter();
const assert = (label: string, condition: boolean, detail?: string): void =>
  condition ? pass(label) : fail(label, detail);

const BASE = 'current repository changes: wf';

async function checkRepoDirAbsent(): Promise<void> {
  console.log(chalk.gray('  1. repoDir absent → base context unchanged'));
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
  assert('returns base context exactly when repoDir is absent', result === BASE, `Got: ${result}`);
}

function assertRepoDirPresentNoRefResult(result: string): void {
  assert('result is longer than base context (enrichment appended)', result.length > BASE.length, `result length ${result.length} vs base ${BASE.length}`);
  assert('conventions section contains expected keywords', /linter|formatter|language|typescript|eslint|prettier|biome/i.test(result), `Conventions keywords not found in:\n${result}`);
  assert('base context is still present in result', result.startsWith(BASE), `Result did not start with base context: ${result.slice(0, 100)}`);
}

async function checkRepoDirPresentNoRef(repoDir: string): Promise<void> {
  console.log(chalk.gray('  2. repoDir present, no commentRef → conventions section appended'));
  let result: string | undefined;
  let threw = false;
  try {
    result = await buildPreReviewContext({ context: BASE, repoDir }, { silent: true });
  } catch (err: any) {
    threw = true;
    fail('threw unexpectedly', err?.message);
  }
  assert('does not throw', !threw);
  if (!threw && result !== undefined) {
    assertRepoDirPresentNoRefResult(result);
  }
}

async function checkNoTicketKey(repoDir: string): Promise<void> {
  console.log(chalk.gray('  3. no ticketKey → resolveVerificationSummary(\'\') completes without throwing'));
  let threw = false;
  const start = Date.now();
  try {
    await buildPreReviewContext({ context: BASE, repoDir }, { silent: true });
  } catch {
    threw = true;
  }
  const elapsed = Date.now() - start;
  assert('does not throw with absent ticketKey', !threw);
  assert('completes within 10 seconds (no stall from git subprocess)', elapsed < 10_000, `Took ${elapsed}ms`);
}

function assertCommentRefPresentResult(result: string): void {
  assert('result is longer than base context (enrichment from live verification + conventions)', result.length > BASE.length, `result length ${result.length} vs base ${BASE.length}`);
  assert('verification markers or script names present (or conventions section without scripts)', /✓|✗|pre-review verification|lint|typecheck|test/i.test(result) || /linter|formatter|language/i.test(result), `Neither verification markers nor conventions found in:\n${result.slice(0, 300)}`);
}

const validateCommentRefResult = (threw: boolean, result: string | undefined): void => {
  assert('does not throw', !threw);
  if (!threw && result !== undefined) {
    assertCommentRefPresentResult(result);
  }
};

async function checkCommentRefPresent(repoDir: string): Promise<void> {
  console.log(chalk.gray('  4. commentRef present → runPreReviewVerification executes (✓/✗ markers or empty)'));
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
  validateCommentRefResult(threw, result);
}

async function main(): Promise<void> {
  console.log(chalk.bold('\nSmoke test: buildPreReviewContext live side effects\n'));
  const repoDir = process.cwd();
  await checkRepoDirAbsent();
  await checkRepoDirPresentNoRef(repoDir);
  await checkNoTicketKey(repoDir);
  await checkCommentRefPresent(repoDir);
  summarise(counts);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
