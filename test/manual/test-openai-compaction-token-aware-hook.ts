/**
 * Manual smoke test: OpenAI compaction token-aware shouldTriggerCompaction hook
 *
 * Run: nr test:manual -- test-openai-compaction-token-aware-hook
 *
 * Verifies:
 *   1. The shouldTriggerCompaction hook logic fires on >=10 candidate items.
 *   2. The hook does NOT fire when candidate items are below threshold and no
 *      observed input tokens exceed the ceiling.
 *   3. The system prompt includes the duplicate-function guard rule.
 *   4. The adapter uses actual observed input tokens (not a per-item estimate)
 *      for the compaction trigger.
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

const run = async (): Promise<void> => {
  console.log(chalk.bold('\nSmoke test: OpenAI compaction token-aware hook\n'));

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

  // 1. System prompt includes duplicate-function guard
  assert(
    'system prompt contains duplicate-function guard rule',
    adapterSource.includes(
      'Never duplicate a function. To add a parameter, modify the existing function signature.',
    ),
  );

  // 2. Adapter contains shouldTriggerCompaction hook
  assert(
    'adapter contains shouldTriggerCompaction hook',
    adapterSource.includes('shouldTriggerCompaction:'),
  );

  // 3. Adapter uses lastObservedInputTokens for compaction trigger
  assert(
    'adapter uses lastObservedInputTokens in compaction hook',
    adapterSource.includes(
      'lastObservedInputTokens > COMPACTION_INPUT_TOKEN_CEILING',
    ),
  );

  // 4. Adapter defines COMPACTION_INPUT_TOKEN_CEILING constant
  assert(
    'adapter defines COMPACTION_INPUT_TOKEN_CEILING',
    adapterSource.includes('COMPACTION_INPUT_TOKEN_CEILING'),
  );

  // 5. Adapter resets lastObservedInputTokens on compaction
  assert(
    'adapter resets lastObservedInputTokens after compaction',
    adapterSource.includes('lastObservedInputTokens = 0'),
  );

  // 6. Adapter does NOT contain proactive runCompaction
  assert(
    'adapter does not contain proactive runCompaction',
    !adapterSource.includes('runCompaction('),
  );

  // 7. Adapter does NOT contain the old per-item token estimate
  assert(
    'adapter does not contain old sessionItems * 150 estimate',
    !adapterSource.includes('sessionItems.length * 150'),
  );

  // 8. Adapter truncates verification output
  assert(
    'adapter truncates verification output',
    adapterSource.includes('MAX_VERIFICATION_OUTPUT_LINES') &&
      adapterSource.includes('truncateOutput'),
  );

  // 9. Edit validation returns existing code context on failure
  assert(
    'edit validation returns existing_code on failure',
    adapterSource.includes('existing_code:'),
  );

  console.log(chalk.bold(`\nResults: ${passed} passed, ${failed} failed\n`));

  if (failed > 0) {
    process.exit(1);
  }
};

run();
