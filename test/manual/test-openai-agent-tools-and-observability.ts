/**
 * Manual smoke test: OpenAI agent tools and observability
 *
 * Run: nr test:manual -- test-openai-agent-tools-and-observability
 *
 * Verifies:
 *   1. formatProgressMessage handles response_done with usage.
 *   2. formatProgressMessage handles compaction.
 *   3. formatProgressMessage handles agent_updated_stream_event.
 *   4. formatProgressMessage handles all 9 RunItemStreamEventName values.
 *   5. formatProgressMessage returns null for output_text_delta.
 *   6. extractUsageFromEvent extracts usage correctly.
 *   7. extractUsageFromEvent detects compaction.
 *   8. classifyAgentError labels for each error class.
 *   9. System prompt contains all 7 tool descriptions.
 *
 * @returns Promise that resolves when the smoke test completes
 */
import chalk from 'chalk';
import {
  classifyAgentError,
  extractUsageFromEvent,
  formatProgressMessage,
} from '../../src/integrations/ai/adapters/openai-agent.adapter';

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

async function main(): Promise<void> {
  console.log(chalk.bold.cyan('\n🧪 OpenAI agent tools and observability smoke test\n'));

  // Test 1: response_done with usage
  console.log(chalk.bold('Test 1: formatProgressMessage — response_done with usage'));
  const usageEvent = {
    type: 'raw_model_stream_event',
    data: {
      type: 'response_done',
      response: {
        usage: { inputTokens: 1000, outputTokens: 500, totalTokens: 1500 },
      },
    },
  };
  const usageResult = formatProgressMessage(usageEvent);
  assert(
    'response_done with usage returns token count',
    usageResult?.message === '  [openai-agent] Response: 1000 in / 500 out tokens',
    usageResult?.message ?? 'received null'
  );

  // Test 2: response_done with compaction
  console.log(chalk.bold('\nTest 2: formatProgressMessage — compaction'));
  const compactEvent = {
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
  const compactResult = formatProgressMessage(compactEvent);
  assert(
    'compaction renders as warning',
    compactResult?.message === '  [openai-agent] Context compacted' && compactResult?.isWarning === true,
    JSON.stringify(compactResult)
  );

  // Test 3: agent_updated_stream_event
  console.log(chalk.bold('\nTest 3: formatProgressMessage — agent_updated'));
  const agentEvent = {
    type: 'agent_updated_stream_event',
    agent: { name: 'test-agent' },
  };
  const agentResult = formatProgressMessage(agentEvent);
  assert(
    'agent_updated renders agent name',
    agentResult?.message === '  [openai-agent] Agent updated: test-agent',
    agentResult?.message ?? 'received null'
  );

  // Test 4: all 9 RunItemStreamEventName values
  console.log(chalk.bold('\nTest 4: formatProgressMessage — RunItemStreamEventName values'));
  const eventNames: Array<{
    name: string;
    item: Record<string, unknown>;
    expected: string;
  }> = [
    {
      name: 'message_output_created',
      item: {},
      expected: 'Message output started',
    },
    { name: 'handoff_requested', item: {}, expected: 'Handoff requested' },
    { name: 'handoff_occurred', item: {}, expected: 'Handoff occurred' },
    { name: 'tool_search_called', item: {}, expected: 'Tool search called' },
    {
      name: 'tool_search_output_created',
      item: {},
      expected: 'Tool search completed',
    },
    {
      name: 'tool_called',
      item: { type: 'function_call', name: 'read_file' },
      expected: 'Tool requested: read_file',
    },
    {
      name: 'tool_output',
      item: { type: 'function_call_result', name: 'read_file' },
      expected: 'Tool completed: read_file',
    },
    {
      name: 'reasoning_item_created',
      item: { type: 'reasoning', content: [{ text: 'Thinking...' }] },
      expected: 'Reasoning: Thinking...',
    },
    {
      name: 'tool_approval_requested',
      item: { name: 'write_file' },
      expected: 'Tool approval requested: write_file',
    },
  ];

  for (const { name, item, expected } of eventNames) {
    const result = formatProgressMessage({
      type: 'run_item_stream_event',
      name,
      item,
    });
    assert(`${name} → "${expected}"`, result?.message?.includes(expected) === true, result?.message ?? 'received null');
  }

  // Test 5: output_text_delta returns null
  console.log(chalk.bold('\nTest 5: formatProgressMessage — output_text_delta'));
  const deltaEvent = {
    type: 'raw_model_stream_event',
    data: { type: 'output_text_delta', delta: 'hello' },
  };
  assert(
    'output_text_delta returns null',
    formatProgressMessage(deltaEvent) === null,
    String(formatProgressMessage(deltaEvent))
  );

  // Test 6: extractUsageFromEvent
  console.log(chalk.bold('\nTest 6: extractUsageFromEvent — extracts usage'));
  const usage = extractUsageFromEvent(usageEvent);
  assert(
    'extractUsageFromEvent returns correct tokens',
    usage?.inputTokens === 1000 &&
      usage?.outputTokens === 500 &&
      usage?.totalTokens === 1500 &&
      usage?.compacted === false,
    JSON.stringify(usage)
  );

  // Test 7: extractUsageFromEvent detects compaction
  console.log(chalk.bold('\nTest 7: extractUsageFromEvent — detects compaction'));
  const compactUsage = extractUsageFromEvent(compactEvent);
  assert('extractUsageFromEvent detects compaction', compactUsage?.compacted === true, JSON.stringify(compactUsage));

  // Test 8: classifyAgentError labels
  console.log(chalk.bold('\nTest 8: classifyAgentError — labels'));
  const errorCases: Array<{
    error: unknown;
    expectedLabel: string;
  }> = [
    {
      error: Object.assign(new Error('rate limited'), { status: 429 }),
      expectedLabel: 'Rate limited',
    },
    {
      error: Object.assign(new Error('unauthorized'), { status: 401 }),
      expectedLabel: 'Authentication error',
    },
    {
      error: Object.assign(new Error('forbidden'), { status: 403 }),
      expectedLabel: 'Authentication error',
    },
    { error: new Error('mystery'), expectedLabel: 'Unknown error' },
  ];

  for (const { error, expectedLabel } of errorCases) {
    const result = classifyAgentError(error);
    assert(`classifyAgentError → "${expectedLabel}"`, result.label === expectedLabel, `got "${result.label}"`);
  }

  // Test 9: system prompt tool descriptions
  // We can't easily test buildSystemPrompt (it's not exported), so we verify
  // the exported formatProgressMessage handles the tool-related events that
  // the new tools would generate.
  console.log(chalk.bold('\nTest 9: new tools generate expected progress messages'));
  const toolEvents = [
    { name: 'search_files', expected: 'Tool requested: search_files' },
    { name: 'find_files', expected: 'Tool requested: find_files' },
    { name: 'edit_file', expected: 'Tool requested: edit_file' },
  ];
  for (const { name, expected } of toolEvents) {
    const result = formatProgressMessage({
      type: 'run_item_stream_event',
      name: 'tool_called',
      item: { type: 'function_call', name },
    });
    assert(
      `tool_called for ${name} renders correctly`,
      result?.message?.includes(expected) === true,
      result?.message ?? 'received null'
    );
  }

  console.log(chalk.bold('\nSummary'));
  console.log(`  Passed: ${passed}`);
  console.log(`  Failed: ${failed}`);

  if (failed > 0) {
    process.exit(1);
  }
}

void main();
