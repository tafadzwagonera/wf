/**
 * Manual smoke test: Context compaction and cached token tracking
 *
 * Run: nr test:manual -- test-compaction-and-cost
 *
 * Verifies:
 *   1. OpenAiUsageSummary type includes cachedInputTokens field.
 *   2. extractUsageFromEvent extracts cachedInputTokens from inputTokensDetails.
 *   3. extractUsageFromEvent defaults cachedInputTokens to 0 when absent.
 *   4. extractUsageFromEvent detects compaction from requestUsageEntries.
 *
 * @returns Promise that resolves when the smoke test completes
 */
import chalk from 'chalk';
import {
  extractUsageFromEvent,
  type OpenAiUsageSummary,
} from '../../src/integrations/ai/adapters/openai-agent.adapter';

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
  console.log(chalk.bold('\nSmoke test: compaction and cost tracking\n'));

  // 1. OpenAiUsageSummary includes cachedInputTokens
  const summary: OpenAiUsageSummary = {
    inputTokens: 100,
    outputTokens: 50,
    totalTokens: 150,
    cachedInputTokens: 25,
    compacted: false,
  };
  assert(
    'OpenAiUsageSummary has cachedInputTokens field',
    summary.cachedInputTokens === 25,
  );

  // 2. extractUsageFromEvent extracts cachedInputTokens
  const eventWithCached = {
    type: 'raw_model_stream_event',
    data: {
      type: 'response_done',
      response: {
        usage: {
          inputTokens: 31376,
          outputTokens: 1063,
          totalTokens: 32439,
          inputTokensDetails: { cachedTokens: 12000 },
        },
      },
    },
  };
  const resultCached = extractUsageFromEvent(eventWithCached);
  assert(
    'extractUsageFromEvent extracts cachedInputTokens from inputTokensDetails',
    resultCached?.cachedInputTokens === 12000,
  );

  // 3. extractUsageFromEvent defaults cachedInputTokens to 0
  const eventWithoutCached = {
    type: 'raw_model_stream_event',
    data: {
      type: 'response_done',
      response: {
        usage: {
          inputTokens: 500,
          outputTokens: 200,
          totalTokens: 700,
        },
      },
    },
  };
  const resultNoCached = extractUsageFromEvent(eventWithoutCached);
  assert(
    'extractUsageFromEvent defaults cachedInputTokens to 0 when absent',
    resultNoCached?.cachedInputTokens === 0,
  );

  // 4. extractUsageFromEvent detects compaction
  const eventCompacted = {
    type: 'raw_model_stream_event',
    data: {
      type: 'response_done',
      response: {
        usage: {
          inputTokens: 2000,
          outputTokens: 100,
          totalTokens: 2100,
          requestUsageEntries: [{ endpoint: 'responses.compact' }],
        },
      },
    },
  };
  const resultCompacted = extractUsageFromEvent(eventCompacted);
  assert(
    'extractUsageFromEvent detects compaction from requestUsageEntries',
    resultCompacted?.compacted === true,
  );

  console.log(chalk.bold(`\nResults: ${passed} passed, ${failed} failed\n`));

  if (failed > 0) {
    process.exit(1);
  }
};

run();
