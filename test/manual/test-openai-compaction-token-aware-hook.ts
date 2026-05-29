/**
 * Manual smoke test: OpenAI compaction token-aware shouldTriggerCompaction hook
 *
 * Run: nr test:manual -- test-openai-compaction-token-aware-hook
 *
 * Verifies:
 *   1. The shouldTriggerCompaction hook logic fires on >=10 candidate items.
 *   2. The hook fires on estimated tokens > 15K (sessionItems.length * 150).
 *   3. The hook does NOT fire when both conditions are below threshold.
 *   4. The system prompt includes the duplicate-function guard rule.
 *   5. The adapter does NOT contain proactive runCompaction or retry logic.
 *
 * @returns Promise that resolves when the smoke test completes
 */
import chalk from 'chalk';
import * as fs from 'fs';
import * as path from 'path';

let passed = 0;
let failed = 0;

/**
 * Asserts a condition and logs the result.
 *
 * @param label - Test case label
 * @param condition - Whether the assertion passed
 */
const assert = (label: string, condition: boolean): void => {
  if (condition) {
    console.log(chalk.green(`  PASS: ${label}`));
    passed++;
  } else {
    console.log(chalk.red(`  FAIL: ${label}`));
    failed++;
  }
};

/**
 * Replicate the shouldTriggerCompaction hook logic from the adapter.
 *
 * @param compactionCandidateItems - Items eligible for compaction
 * @param sessionItems - All session items
 * @returns Whether compaction should trigger
 */
const shouldTriggerCompaction = ({
  compactionCandidateItems,
  sessionItems,
}: {
  compactionCandidateItems: unknown[];
  sessionItems: unknown[];
}): boolean => {
  if (compactionCandidateItems.length >= 10) {
    return true;
  }
  const estimatedTokens = sessionItems.length * 150;
  return estimatedTokens > 15_000;
};

const run = async (): Promise<void> => {
  console.log(chalk.bold('\nSmoke test: OpenAI compaction token-aware hook\n'));

  // 1. >=10 candidate items triggers compaction
  assert(
    'triggers on >=10 candidate items',
    shouldTriggerCompaction({
      compactionCandidateItems: Array.from({ length: 10 }),
      sessionItems: Array.from({ length: 5 }),
    }),
  );

  // 2. >100 session items (101 * 150 = 15150 > 15000) triggers compaction
  assert(
    'triggers on estimated tokens > 15K (101 session items)',
    shouldTriggerCompaction({
      compactionCandidateItems: Array.from({ length: 2 }),
      sessionItems: Array.from({ length: 101 }),
    }),
  );

  // 3. Both below threshold does NOT trigger
  assert(
    'does not trigger when both conditions below threshold',
    !shouldTriggerCompaction({
      compactionCandidateItems: Array.from({ length: 3 }),
      sessionItems: Array.from({ length: 50 }),
    }),
  );

  // 4. Boundary: exactly 100 session items (100 * 150 = 15000, NOT > 15000)
  assert(
    'does not trigger at exact boundary (100 items = 15000 tokens)',
    !shouldTriggerCompaction({
      compactionCandidateItems: Array.from({ length: 9 }),
      sessionItems: Array.from({ length: 100 }),
    }),
  );

  const adapterSource = fs.readFileSync(
    path.join(
      __dirname,
      '..',
      '..',
      'src',
      'integrations',
      'ai',
      'adapters',
      'openai-agent.adapter.ts',
    ),
    'utf8',
  );

  // 5. System prompt includes duplicate-function guard
  assert(
    'system prompt contains duplicate-function guard rule',
    adapterSource.includes(
      'Never duplicate a function. To add a parameter, modify the existing function signature.',
    ),
  );

  // 6. Adapter contains shouldTriggerCompaction hook
  assert(
    'adapter contains shouldTriggerCompaction hook',
    adapterSource.includes('shouldTriggerCompaction:'),
  );

  // 7. Adapter contains 15_000 token threshold in hook
  assert(
    'adapter uses 15_000 token threshold in hook',
    adapterSource.includes('estimatedTokens > 15_000'),
  );

  // 8. Adapter does NOT contain proactive runCompaction
  assert(
    'adapter does not contain proactive runCompaction',
    !adapterSource.includes('runCompaction('),
  );

  // 9. Adapter does NOT contain rate limit retry logic
  assert(
    'adapter does not contain rate limit retry logic',
    !adapterSource.includes('maxRateLimitRetries'),
  );

  // 10. Adapter does NOT contain COMPACTION_TOKEN_THRESHOLD constant
  assert(
    'adapter does not contain COMPACTION_TOKEN_THRESHOLD',
    !adapterSource.includes('COMPACTION_TOKEN_THRESHOLD'),
  );

  console.log(chalk.bold(`\nResults: ${passed} passed, ${failed} failed\n`));

  if (failed > 0) {
    process.exit(1);
  }
};

run();
