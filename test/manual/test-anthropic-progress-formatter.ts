/**
 * Manual smoke test: agent progress formatter and help text contract
 *
 * Run: nr test:manual -- test-anthropic-progress-formatter
 *
 * Verifies:
 *   1. Anthropic task progress messages render without heuristic suffixes.
 *   2. Anthropic tool progress messages render without heuristic suffixes.
 *   3. Anthropic explicit activity logs stay human-readable.
 *   4. Generated issue:implement help text documents the shared explicit-log contract.
 *
 * @returns Promise that resolves when the smoke test completes
 */
import * as path from 'path';
import chalk from 'chalk';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import {
  formatActivityMessages,
  formatProgressMessage as formatAnthropicProgressMessage,
} from '../../src/integrations/ai/adapters/anthropic-agent.adapter';
import { formatProgressMessage as formatOpenAiProgressMessage } from '../../src/integrations/ai/adapters/openai-agent.adapter';
import { getCommandHelpCatalog } from '../../src/bootstrap/help-catalog-parser';
import { getHelpText } from '../../src/bootstrap/help-output';

const ANSI_ESCAPE = String.fromCharCode(27);
const ANSI_PATTERN = new RegExp(`${ANSI_ESCAPE}\\[[0-9;]*m`, 'g');

let passed = 0;
let failed = 0;

/**
 * Record a passing assertion.
 *
 * @param message Human-readable assertion label
 * @returns Void
 */
const pass = (message: string): void => {
  console.log(chalk.green(`  ✓ ${message}`));
  passed += 1;
};

/**
 * Record a failing assertion.
 *
 * @param message Human-readable assertion label
 * @param detail Optional failure detail
 * @returns Void
 */
const fail = (message: string, detail?: string): void => {
  console.error(chalk.red(`  ✗ ${message}${detail ? `\n    → ${detail}` : ''}`));
  failed += 1;
};

/**
 * Assert a boolean condition and record the result.
 *
 * @param message Human-readable assertion label
 * @param condition Assertion condition
 * @param detail Optional failure detail
 * @returns Void
 */
const assert = (message: string, condition: boolean, detail?: string): void => {
  if (condition) {
    pass(message);
    return;
  }

  fail(message, detail);
};

/**
 * Strip ANSI sequences so help text can be checked as plain text.
 *
 * @param value Colored terminal output
 * @returns Plain-text representation
 */
const stripAnsi = (value: string): string => value.replaceAll(ANSI_PATTERN, '');

/**
 * Collapse wrapped terminal output into a single normalized line.
 *
 * @param value Terminal output that may contain line wraps
 * @returns Whitespace-normalized text
 */
const normalizeWhitespace = (value: string): string => value.replaceAll(/\s+/g, ' ').trim();

async function main(): Promise<void> {
  console.log(chalk.bold.cyan('\n🧪 Agent progress formatter smoke test\n'));

  console.log(chalk.bold('Test 1: task progress formatting stays stable'));
  const taskMessage = {
    type: 'system',
    subtype: 'task_progress',
    summary: 'Inspecting verification output',
    description: 'Inspecting verification output',
    last_tool_name: 'Bash',
  } as SDKMessage;
  const formattedTaskMessage = formatAnthropicProgressMessage(taskMessage);
  assert(
    'task progress line matches the stable contract',
    formattedTaskMessage === '  [claude-agent-sdk] Task progress: Inspecting verification output · last tool: Bash',
    formattedTaskMessage ?? 'received null'
  );
  assert(
    'task progress line does not contain heuristic progress text',
    !formattedTaskMessage?.includes('progress: continue'),
    formattedTaskMessage ?? 'received null'
  );

  console.log(chalk.bold('\nTest 2: tool progress formatting stays stable'));
  const toolMessage = {
    type: 'tool_progress',
    tool_name: 'Write',
    elapsed_time_seconds: 2.4,
    task_id: 'task-1',
  } as SDKMessage;
  const formattedToolMessage = formatAnthropicProgressMessage(toolMessage);
  assert(
    'tool progress line matches the stable contract',
    formattedToolMessage === '  [claude-agent-sdk] Tool progress: Write (2.4s) · task: task-1',
    formattedToolMessage ?? 'received null'
  );
  assert(
    'tool progress line does not contain heuristic progress text',
    !formattedToolMessage?.includes('progress: continue'),
    formattedToolMessage ?? 'received null'
  );

  console.log(chalk.bold('\nTest 3: Anthropic explicit activity logs stay readable'));
  const activityMessages = formatActivityMessages(
    {
      type: 'system',
      subtype: 'files_persisted',
      files: [{ filename: '/repo/primary/src/foo.ts', file_id: 'file-1' }],
      failed: [],
      processed_at: '2026-05-21T10:00:00.000Z',
      uuid: '11111111-1111-1111-1111-111111111115',
      session_id: 'session-5',
    } as SDKMessage,
    '/repo/primary',
    {}
  );
  assert(
    'file persistence is rendered as an explicit file log',
    activityMessages[0] === '  [claude-agent-sdk] File updated: src/foo.ts',
    activityMessages.join(' | ')
  );

  const openAiResult = formatOpenAiProgressMessage({
    type: 'run_item_stream_event',
    item: {
      type: 'reasoning',
      content: [{ text: 'Investigating verification output' }],
    },
  });
  const openAiMessage = openAiResult?.message ?? null;
  assert(
    'OpenAI reasoning stays concise and omits heuristic progress text',
    openAiMessage === '  [openai-agent] Reasoning: Investigating verification output',
    openAiMessage ?? 'received null'
  );

  console.log(chalk.bold('\nTest 4: issue:implement help text documents the shared progress contract'));
  const repoRoot = path.join(__dirname, '..', '..');
  const catalog = getCommandHelpCatalog(path.join(repoRoot, 'src', 'commands'));
  const helpText = normalizeWhitespace(stripAnsi(getHelpText(['issue:implement', '--help'], catalog)));

  assert(
    'help text mentions shared explicit file and verification logs',
    helpText.includes(
      'Both backends emit stable SDK task and tool progress lines plus explicit file mutation logs and verification logs'
    )
  );
  assert(
    'help text no longer mentions OpenAI heuristic progress signals',
    !helpText.includes('the OpenAI backend emits heuristic progress signals'),
    helpText
  );
  assert(
    'help text still mentions both Anthropic and OpenAI backends',
    helpText.includes('Anthropic or OpenAI agent backend')
  );

  console.log(chalk.bold('\nSummary'));
  console.log(`  Passed: ${passed}`);
  console.log(`  Failed: ${failed}`);

  if (failed > 0) {
    process.exit(1);
  }
}

void main();
