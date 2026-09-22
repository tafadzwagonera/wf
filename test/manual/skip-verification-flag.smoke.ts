/**
 * Manual smoke test: --skip-verification flag bypasses pre-review
 * verification entirely
 *
 * Run: nr test:manual skip-verification-flag.smoke.ts
 */

import chalk from 'chalk';
import { buildPreReviewContext } from '../../src/shared/utils/build-pre-review-context';

import { createReporter, summarise } from './support/reporter';

const { counts, pass, fail } = createReporter();
const assert = (label: string, condition: boolean, detail?: string): void =>
  condition ? pass(label) : fail(label, detail);

function assertSkipTrueResult(result: string, elapsed: number, BASE: string): void {
  assert('completes in under 500ms (no worktree or subprocess overhead)', elapsed < 500, `Took ${elapsed}ms`);
  assert(
    'result does not contain verification markers',
    !(/✓|✗/.test(result) && /Pre-review verification/.test(result)),
    `Found verification output in: ${result.slice(0, 200)}`,
  );
  assert('result still contains base context', result.startsWith(BASE), `Result did not start with base context`);
  const hasConventions = /linter|formatter|language|typescript|eslint|prettier|biome/i.test(result);
  assert('conventions section still appended (other enrichment unaffected)', hasConventions, `Conventions keywords not found in result`);
}

async function checkSkipTrue(repoDir: string, BASE: string): Promise<void> {
  console.log(chalk.gray('  1. skipVerification: true — no verification runs'));
  const start = Date.now();
  const result = await buildPreReviewContext(
    { context: BASE, repoDir, commentRef: 'https://example.com/pr/1' },
    { skipVerification: true, silent: true },
  );
  assertSkipTrueResult(result, Date.now() - start, BASE);
}

async function checkSkipFalse(repoDir: string, BASE: string): Promise<void> {
  console.log(chalk.gray('  2. skipVerification: false — verification runs normally'));
  const result = await buildPreReviewContext(
    { context: BASE, repoDir, commentRef: 'https://example.com/pr/1' },
    { skipVerification: false, silent: true },
  );
  assert(
    'result is longer than base context (enrichment appended)',
    result.length > BASE.length,
    `result length ${result.length} vs base ${BASE.length}`,
  );
}

async function main(): Promise<void> {
  console.log(chalk.bold('\nSmoke test: --skip-verification flag\n'));
  const repoDir = process.cwd();
  const BASE = 'current repository changes: wf';
  await checkSkipTrue(repoDir, BASE);
  await checkSkipFalse(repoDir, BASE);
  summarise(counts);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
