/**
 * Manual smoke test: anthropic-agent session diagnostic message formatting
 *
 * Run: nr test:manual -- test-anthropic-agent-session-diagnostics
 *
 * Verifies:
 *   1. api_retry messages render with HTTP status and backoff delay.
 *   2. api_retry with null error_status renders as "connection error".
 *   3. status messages render the status string.
 *   4. status with null returns null (suppressed).
 *   5. rate_limit_event messages render.
 *
 * @returns Promise that resolves when the smoke test completes
 */
import chalk from 'chalk';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { formatProgressMessage } from '../../src/integrations/ai/adapters/anthropic-agent.adapter';

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
  console.error(
    chalk.red(`  ✗ ${message}${detail ? `\n    → ${detail}` : ''}`),
  );
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
  console.log(
    chalk.bold.cyan('\n🧪 Anthropic agent session diagnostics smoke test\n'),
  );

  console.log(chalk.bold('Test 1: api_retry with HTTP status'));
  const apiRetryHttp = formatProgressMessage({
    type: 'system',
    subtype: 'api_retry',
    attempt: 2,
    max_retries: 5,
    error_status: 529,
    retry_delay_ms: 4000,
  } as SDKMessage);
  assert(
    'api_retry renders HTTP status and backoff',
    apiRetryHttp ===
      '  [claude-agent-sdk] API retry: attempt 2/5 after HTTP 529 (4000ms backoff)',
    apiRetryHttp ?? 'received null',
  );

  console.log(chalk.bold('\nTest 2: api_retry with null error_status'));
  const apiRetryConn = formatProgressMessage({
    type: 'system',
    subtype: 'api_retry',
    attempt: 1,
    max_retries: 3,
    error_status: null,
    retry_delay_ms: 1000,
  } as SDKMessage);
  assert(
    'api_retry renders connection error when error_status is null',
    apiRetryConn ===
      '  [claude-agent-sdk] API retry: attempt 1/3 after connection error (1000ms backoff)',
    apiRetryConn ?? 'received null',
  );

  console.log(chalk.bold('\nTest 3: status message'));
  const statusMsg = formatProgressMessage({
    type: 'system',
    subtype: 'status',
    status: 'compacting',
  } as SDKMessage);
  assert(
    'status renders the status string',
    statusMsg === '  [claude-agent-sdk] Status: compacting',
    statusMsg ?? 'received null',
  );

  console.log(chalk.bold('\nTest 4: status with null returns null'));
  const statusNull = formatProgressMessage({
    type: 'system',
    subtype: 'status',
    status: null,
  } as SDKMessage);
  assert('status null returns null', statusNull === null, String(statusNull));

  console.log(chalk.bold('\nTest 5: rate_limit_event'));
  const rateLimit = formatProgressMessage({
    type: 'rate_limit_event',
  } as SDKMessage);
  assert(
    'rate_limit_event renders',
    rateLimit === '  [claude-agent-sdk] Rate limit: updated',
    rateLimit ?? 'received null',
  );

  console.log(chalk.bold('\nTest 6: compact_boundary'));
  const compact = formatProgressMessage({
    type: 'system',
    subtype: 'compact_boundary',
    compact_metadata: {
      trigger: 'auto',
      pre_tokens: 32000,
    },
  } as SDKMessage);
  assert(
    'compact_boundary renders trigger and token count',
    compact ===
      '  [claude-agent-sdk] Context compacted (auto, 32000 tokens before)',
    compact ?? 'received null',
  );

  console.log(chalk.bold('\nTest 7: session_state_changed'));
  const stateChanged = formatProgressMessage({
    type: 'system',
    subtype: 'session_state_changed',
    state: 'idle',
  } as SDKMessage);
  assert(
    'session_state_changed renders state',
    stateChanged === '  [claude-agent-sdk] Session state: idle',
    stateChanged ?? 'received null',
  );

  console.log(chalk.bold('\nSummary'));
  console.log(`  Passed: ${passed}`);
  console.log(`  Failed: ${failed}`);

  if (failed > 0) {
    process.exit(1);
  }
}

void main();
