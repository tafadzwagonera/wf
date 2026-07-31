/**
 * Manual smoke test: Codex CLI NDJSON protocol extraction
 *
 * Run: nr test:manual -- test-codex-cli-ndjson-protocol
 *
 * Verifies:
 *   1. Session ID is extracted from thread.started events (thread_id field).
 *   2. Session ID is NOT extracted from the legacy session_id field.
 *   3. Result text is extracted from item.completed agent_message events.
 *   4. Result text is NOT extracted from the legacy type:'result' events.
 *   5. Last agent_message wins when multiple are emitted.
 *   6. Empty item.text is skipped (truthy guard).
 */
import chalk from 'chalk';
import type { CodexCliMessage } from '../../src/integrations/ai/adapters/codex-cli-runner';

let passed = 0;
let failed = 0;

const pass = (message: string): void => {
  console.log(chalk.green(`  \u2713 ${message}`));
  passed += 1;
};

const fail = (message: string, detail?: string): void => {
  console.error(chalk.red(`  \u2717 ${message}${detail ? `\n    \u2192 ${detail}` : ''}`));
  failed += 1;
};

const assert = (message: string, condition: boolean, detail?: string): void => {
  if (condition) {
    pass(message);
    return;
  }
  fail(message, detail);
};

/**
 * Mirrors the extraction logic in runCodexCliStagePrompt (stage-agent.service.ts)
 * and the adapter loop (codex-cli.adapter.ts) so we can validate it in isolation.
 */
const extractFromStream = (messages: CodexCliMessage[]): { sessionId: string | undefined; result: string } => {
  let sessionId: string | undefined;
  let result = '';

  for (const message of messages) {
    if (message.type === 'thread.started' && message.thread_id) {
      sessionId = message.thread_id;
    }

    if (message.type === 'item.completed' && message.item?.type === 'agent_message' && message.item.text) {
      result = message.item.text;
    }
  }

  return { sessionId, result };
};

async function main(): Promise<void> {
  console.log(chalk.bold.cyan('\n  Codex CLI NDJSON protocol extraction smoke test\n'));

  // --- Test 1: Session ID from thread.started ---
  console.log(chalk.bold('Test 1: Session ID extracted from thread.started event'));
  {
    const { sessionId } = extractFromStream([
      { type: 'thread.started', thread_id: 'tid-abc-123' },
      {
        type: 'item.completed',
        item: { type: 'agent_message', text: 'hello' },
      },
    ]);
    assert('sessionId equals thread_id value', sessionId === 'tid-abc-123', `got: ${sessionId}`);
  }

  // --- Test 2: Legacy session_id field is ignored ---
  console.log(chalk.bold('\nTest 2: Legacy session_id field is ignored'));
  {
    const { sessionId } = extractFromStream([
      { type: 'some.event', session_id: 'legacy-sess-id' },
      {
        type: 'item.completed',
        item: { type: 'agent_message', text: 'hello' },
      },
    ]);
    assert('sessionId is undefined when only session_id is present', sessionId === undefined, `got: ${sessionId}`);
  }

  // --- Test 3: Result from item.completed agent_message ---
  console.log(chalk.bold('\nTest 3: Result extracted from item.completed agent_message'));
  {
    const { result } = extractFromStream([
      {
        type: 'item.completed',
        item: { type: 'agent_message', text: 'the plan output' },
      },
    ]);
    assert('result equals agent_message text', result === 'the plan output', `got: ${result}`);
  }

  // --- Test 4: Legacy type:'result' events are ignored ---
  console.log(chalk.bold('\nTest 4: Legacy type:\'result\' events produce no result'));
  {
    const { result } = extractFromStream([{ type: 'result', result: 'should be ignored', is_error: false }]);
    assert('result is empty when only type:result events are present', result === '', `got: ${JSON.stringify(result)}`);
  }

  // --- Test 5: Last agent_message wins ---
  console.log(chalk.bold('\nTest 5: Last agent_message wins when multiple are emitted'));
  {
    const { result } = extractFromStream([
      {
        type: 'item.completed',
        item: { type: 'agent_message', text: 'first' },
      },
      {
        type: 'item.completed',
        item: { type: 'agent_message', text: 'second' },
      },
      {
        type: 'item.completed',
        item: { type: 'agent_message', text: 'third' },
      },
    ]);
    assert('result equals last agent_message text', result === 'third', `got: ${result}`);
  }

  // --- Test 6: Empty item.text is skipped ---
  console.log(chalk.bold('\nTest 6: Empty item.text is skipped'));
  {
    const { result } = extractFromStream([
      {
        type: 'item.completed',
        item: { type: 'agent_message', text: 'real content' },
      },
      {
        type: 'item.completed',
        item: { type: 'agent_message', text: '' },
      },
    ]);
    assert('result retains previous non-empty text', result === 'real content', `got: ${result}`);
  }

  // --- Summary ---
  console.log(chalk.bold('\nSummary'));
  console.log(`  Passed: ${passed}`);
  console.log(`  Failed: ${failed}`);

  if (failed > 0) {
    process.exit(1);
  }
}

void main();
