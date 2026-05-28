/**
 * Manual smoke test: shared agent progress output contract
 *
 * Run: nr test:manual -- test-agent-progress-output
 *
 * Verifies:
 *   1. OpenAI streamed progress messages remain concise.
 *   2. Anthropic streamed progress messages remain concise.
 *   3. Anthropic file persistence messages render as explicit file logs.
 *   4. Verification log labels stay explicit across both adapters.
 *
 * @returns Promise that resolves when the smoke test completes
 */
import chalk from 'chalk';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import {
  formatActivityMessages,
  formatProgressMessage as formatAnthropicProgressMessage,
} from '../../src/integrations/ai/adapters/anthropic-agent.adapter';
import { formatProgressMessage as formatOpenAiProgressMessage } from '../../src/integrations/ai/adapters/openai-agent.adapter';

let passed = 0;
let failed = 0;

const pass = (message: string): void => {
  console.log(chalk.green(`  ✓ ${message}`));
  passed += 1;
};

const fail = (message: string, detail?: string): void => {
  console.error(
    chalk.red(`  ✗ ${message}${detail ? `\n    → ${detail}` : ''}`),
  );
  failed += 1;
};

const assert = (message: string, condition: boolean, detail?: string): void => {
  if (condition) {
    pass(message);
    return;
  }

  fail(message, detail);
};

async function main(): Promise<void> {
  console.log(
    chalk.bold.cyan('\n🧪 Shared agent progress output smoke test\n'),
  );

  console.log(chalk.bold('Test 1: OpenAI streamed progress stays concise'));
  const openAiResult = formatOpenAiProgressMessage({
    type: 'run_item_stream_event',
    item: {
      type: 'reasoning',
      content: [{ text: 'Inspecting the failing verification output' }],
    },
  });
  const openAiMessage = openAiResult?.message ?? null;
  assert(
    'OpenAI reasoning log stays human-readable',
    openAiMessage ===
      '  [openai-agent] Reasoning: Inspecting the failing verification output',
    openAiMessage ?? 'received null',
  );
  assert(
    'OpenAI reasoning log omits heuristic progress suffixes',
    !openAiMessage?.includes('progress:'),
    openAiMessage ?? 'received null',
  );

  console.log(
    chalk.bold('\nTest 2: Anthropic streamed progress stays concise'),
  );
  const anthropicMessage = formatAnthropicProgressMessage({
    type: 'tool_progress',
    tool_name: 'Write',
    elapsed_time_seconds: 1.6,
    task_id: 'task-42',
  } as SDKMessage);
  assert(
    'Anthropic tool progress log stays human-readable',
    anthropicMessage ===
      '  [claude-agent-sdk] Tool progress: Write (1.6s) · task: task-42',
    anthropicMessage ?? 'received null',
  );
  assert(
    'Anthropic tool progress log omits heuristic progress suffixes',
    !anthropicMessage?.includes('continue') &&
      !anthropicMessage?.includes('revisit') &&
      !anthropicMessage?.includes('complete'),
    anthropicMessage ?? 'received null',
  );

  console.log(chalk.bold('\nTest 3: explicit file logs remain stable'));
  const activityState = { lastVerificationCommand: 'npm test' };
  const activityMessages = formatActivityMessages(
    {
      type: 'system',
      subtype: 'files_persisted',
      files: [{ filename: '/repo/primary/src/foo.ts', file_id: 'file-1' }],
      failed: [],
      processed_at: '2026-05-21T10:00:00.000Z',
      uuid: '11111111-1111-1111-1111-111111111215',
      session_id: 'session-15',
    } as SDKMessage,
    '/repo/primary',
    activityState,
  );
  assert(
    'Anthropic file persistence maps to an explicit file update log',
    activityMessages[0] === '  [claude-agent-sdk] File updated: src/foo.ts',
    activityMessages.join(' | '),
  );

  console.log(chalk.bold('\nTest 4: verification labels remain explicit'));
  const verificationMessages = formatActivityMessages(
    {
      type: 'tool_use_summary',
      summary: 'Ran `npm test` successfully.',
      preceding_tool_use_ids: ['tool-use-1'],
      uuid: '11111111-1111-1111-1111-111111111216',
      session_id: 'session-16',
    } as SDKMessage,
    '/repo/primary',
    activityState,
  );
  assert(
    'Anthropic verification summary maps to an explicit pass log',
    verificationMessages[0] ===
      '  [claude-agent-sdk] Verification passed: npm test',
    verificationMessages.join(' | '),
  );

  console.log(chalk.bold('\nSummary'));
  console.log(`  Passed: ${passed}`);
  console.log(`  Failed: ${failed}`);

  if (failed > 0) {
    process.exit(1);
  }
}

void main();
