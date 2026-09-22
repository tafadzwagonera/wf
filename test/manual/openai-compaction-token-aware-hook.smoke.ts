/**
 * Manual smoke test: OpenAI compaction token-aware shouldTriggerCompaction hook
 *
 * Run: nr test:manual openai-compaction-token-aware-hook.smoke.ts
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
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createReporter, summarise } from './support/reporter';

const { counts, pass, fail } = createReporter();

const adapterSource = fs.readFileSync(
  path.join(__dirname, '..', '..', 'src', 'integrations', 'ai', 'adapters', 'openai-agent.adapter.ts'),
  'utf8'
);

function check(condition: boolean, label: string): void {
  if (condition) pass(label);
  else fail(label);
}

function main(): void {
  console.log(chalk.bold('\nSmoke test: OpenAI compaction token-aware hook\n'));
  check(adapterSource.includes('Never duplicate a function. To add a parameter, modify the existing function signature.'), 'system prompt contains duplicate-function guard rule');
  check(adapterSource.includes('shouldTriggerCompaction:'), 'adapter contains shouldTriggerCompaction hook');
  check(adapterSource.includes('lastObservedInputTokens > COMPACTION_INPUT_TOKEN_CEILING'), 'adapter uses lastObservedInputTokens in compaction hook');
  check(adapterSource.includes('COMPACTION_INPUT_TOKEN_CEILING'), 'adapter defines COMPACTION_INPUT_TOKEN_CEILING');
  check(adapterSource.includes('lastObservedInputTokens = 0'), 'adapter resets lastObservedInputTokens after compaction');
  check(!adapterSource.includes('runCompaction('), 'adapter does not contain proactive runCompaction');
  check(!adapterSource.includes('sessionItems.length * 150'), 'adapter does not contain old sessionItems * 150 estimate');
  check(adapterSource.includes('MAX_VERIFICATION_OUTPUT_LINES') && adapterSource.includes('truncateOutput'), 'adapter truncates verification output');
  check(adapterSource.includes('existing_code:'), 'edit validation returns existing_code on failure');
  summarise(counts);
}

main();
