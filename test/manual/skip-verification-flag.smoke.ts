/**
 * Manual smoke test: --skip-verification flag bypasses pre-review
 * verification entirely
 *
 * Run: nr test:manual -- test-skip-verification-flag
 */

import chalk from 'chalk';
import { buildPreReviewContext } from '../../src/shared/utils/build-pre-review-context';

import { createReporter } from './support/reporter';

const { counts, pass, fail } = createReporter();
const assert = (label: string, condition: boolean, detail?: string): void =>
  condition ? pass(label) : fail(label, detail);

async function main(): Promise<void> {
  console.log(chalk.bold('\nSmoke test: --skip-verification flag\n'));

  const repoDir = process.cwd();
  const BASE = 'current repository changes: wf';

  console.log(chalk.gray('  1. skipVerification: true — no verification runs'));
  {
    const start = Date.now();
    const result = await buildPreReviewContext(
      { context: BASE, repoDir, commentRef: 'https://example.com/pr/1' },
      { skipVerification: true, silent: true },
    );
    const elapsed = Date.now() - start;

    assert(
      'completes in under 500ms (no worktree or subprocess overhead)',
      elapsed < 500,
      `Took ${elapsed}ms`,
    );
    assert(
      'result does not contain verification markers',
      !(/✓|✗/.test(result) && /Pre-review verification/.test(result)),
      `Found verification output in: ${result.slice(0, 200)}`,
    );
    assert(
      'result still contains base context',
      result.startsWith(BASE),
      `Result did not start with base context`,
    );
    const hasConventions = /linter|formatter|language|typescript|eslint|prettier|biome/i.test(result);
    assert(
      'conventions section still appended (other enrichment unaffected)',
      hasConventions,
      `Conventions keywords not found in result`,
    );
  }

  console.log(chalk.gray('  2. skipVerification: false — verification runs normally'));
  {
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

  console.log(chalk.bold(`\n  ${counts.passed} passed, ${counts.failed} failed\n`));
  if (counts.failed > 0) process.exit(1);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
