/**
 * Manual smoke test: compaction-aware stall threshold raises effective limit
 *
 * Run: nr test:manual -- test-compaction-aware-stall-threshold
 *
 * Scenario: The review stage using claude-opus-4-6 triggers 6+ compaction
 * cycles on large diffs. After compaction, the model returns assistant_text
 * instead of structured JSON. The stall detector (CLI_STALL_THRESHOLD = 2)
 * would previously treat 2 consecutive assistant_text fallbacks as terminal
 * failure. With the compaction boost, each compact_boundary event grants one
 * extra retry attempt, capped at CLI_MAX_COMPACTION_BOOST = 4 (effective max
 * threshold: 6).
 *
 * Config under test:
 *   CLI_STALL_THRESHOLD = 2 (from DEFAULT_STALL_THRESHOLD)
 *   CLI_MAX_COMPACTION_BOOST = 4
 *
 * Verify:
 *   1. Without compaction: stall threshold fires after exactly 2 consecutive
 *      assistant_text passes (unchanged default behavior)
 *   2. With 1 compact_boundary event: effective threshold is 3 — the third
 *      stalled pass triggers the error, not the second
 *   3. With 6 compact_boundary events: boost is capped at 4, so effective
 *      threshold is 6 — the sixth stalled pass triggers the error
 *   4. compactionCount resets per pass accumulator, but compactionBoost
 *      persists across the retry loop (intentional — compaction indicates
 *      persistent context pressure)
 *   5. A successful pass (source !== 'assistant_text') still resets
 *      stalledPasses to 0, regardless of compaction boost
 *   6. Observability: the error message still includes "workload not
 *      decreasing" and pass diagnostics
 *
 * Wire up: mirror CliPassAccumulator, CliPassResult, CliRetryState,
 * accumulateCliMessage, finalizeCliPass, advanceCliRetryState, and
 * checkCliStallCondition from stage-agent.service.ts (they are not exported).
 * Use the same mirroring pattern as test-cli-assistant-text-rejection.ts.
 * Feed synthetic NDJSON messages with type:'system', subtype:'compact_boundary'
 * through the accumulator and verify compactionCount increments. Then feed
 * stalled pass results through the retry loop and verify the effective
 * threshold shifts.
 *
 * Teardown: none — no file system or config side effects.
 */

import chalk from 'chalk';
import { DEFAULT_STALL_THRESHOLD } from '../../src/integrations/ai/adapters/verification-report';

let passed = 0;
let failed = 0;

const pass = (message: string): void => {
  console.log(chalk.green(`  \u2713 ${message}`));
  passed += 1;
};

const fail = (message: string, detail?: string): void => {
  const suffix = detail ? `\n    \u2192 ${detail}` : '';
  console.error(chalk.red(`  \u2717 ${message}${suffix}`));
  failed += 1;
};

const assert = (label: string, condition: boolean, detail?: string): void => {
  if (condition) {
    pass(label);
    return;
  }
  fail(label, detail);
};

// --- Mirrored types and functions from stage-agent.service.ts (non-exported) ---

type CliPassResult = {
  compactionCount: number;
  diagnostics: string[];
  hadContent: boolean;
  result: string;
  sessionId: string | undefined;
  source: 'structured_output' | 'result' | 'assistant_text' | undefined;
  stopReason: string | undefined;
};

type CliRetryState = {
  compactionBoost: number;
  sessionId?: string;
  stalledPasses: number;
  passNumber: number;
  lastDiagnostics: string[];
};

type CliPassAccumulator = {
  compactionCount: number;
  diagnostics: string[];
  lastAssistantText: string;
  result: string;
  sessionId: string | undefined;
  source: CliPassResult['source'];
  stopReason: string | undefined;
};

const CLI_STALL_THRESHOLD = DEFAULT_STALL_THRESHOLD;
const CLI_MAX_COMPACTION_BOOST = 4;

/**
 * Mirrors extractAssistantText in stage-agent.service.ts.
 */
const extractAssistantText = (
  message: Record<string, unknown>
): string | undefined => {
  if (message.type !== 'assistant') return undefined;
  const msg = message.message;
  if (!msg || typeof msg !== 'object' || !('content' in msg)) return undefined;
  const blocks = (msg as { content: unknown[] }).content;
  if (!Array.isArray(blocks)) return undefined;
  let turnText = '';
  for (const block of blocks) {
    if (
      typeof block === 'object'
      && block !== null
      && (block as Record<string, unknown>).type === 'text'
      && typeof (block as Record<string, unknown>).text === 'string'
    ) {
      turnText += (block as { text: string }).text;
    }
  }
  return turnText || undefined;
};

/**
 * Mirrors extractCliResultContent in stage-agent.service.ts.
 */
const extractCliResultContent = (
  message: Record<string, unknown>
): { result: string; source: 'structured_output' | 'result' } | undefined => {
  if (message.type !== 'result' || message.is_error) return undefined;
  if (message.structured_output && typeof message.structured_output === 'object') {
    return { result: JSON.stringify(message.structured_output), source: 'structured_output' };
  }
  if (message.result) return { result: message.result as string, source: 'result' };
  return undefined;
};

/**
 * Mirrors accumulateCliMessage in stage-agent.service.ts (compaction-aware version).
 */
const accumulateCliMessage = (
  acc: CliPassAccumulator, message: Record<string, unknown>
): void => {
  if (message.session_id) acc.sessionId = message.session_id as string;
  if (message.type === 'system' && message.subtype === 'compact_boundary') acc.compactionCount++;
  const assistantText = extractAssistantText(message);
  if (assistantText) acc.lastAssistantText = assistantText;
  const extracted = extractCliResultContent(message);
  if (extracted) {
    acc.result = extracted.result;
    acc.source = extracted.source;
    acc.stopReason = message.stop_reason as string | undefined;
  }
};

/**
 * Mirrors finalizeCliPass in stage-agent.service.ts (compaction-aware version).
 */
const finalizeCliPass = (acc: CliPassAccumulator): CliPassResult => {
  const result = acc.result || (acc.lastAssistantText.trim() ? acc.lastAssistantText : '');
  const fallbackSource = acc.lastAssistantText.trim() ? 'assistant_text' as const : acc.source;
  const source = acc.result ? acc.source : fallbackSource;
  const hadContent = acc.lastAssistantText.trim().length > 0;
  return {
    compactionCount: acc.compactionCount,
    result, source, stopReason: acc.stopReason,
    sessionId: acc.sessionId, hadContent, diagnostics: acc.diagnostics,
  };
};

/**
 * Mirrors checkCliStallCondition in stage-agent.service.ts (threshold-aware version).
 */
const checkCliStallCondition = (
  stalledPasses: number, passNumber: number, lastDiagnostics: string[], threshold = CLI_STALL_THRESHOLD
): void => {
  if (stalledPasses < threshold) return;
  const detail = lastDiagnostics.length ? ` Diagnostics:\n${lastDiagnostics.join('\n')}` : '';
  const error = new Error(
    `Claude CLI finished without returning a result after ${passNumber} pass(es) \u2014 workload not decreasing.${detail}`
  );
  error.name = 'AiProviderError';
  throw error;
};

/**
 * Mirrors advanceCliRetryState in stage-agent.service.ts (compaction-aware version).
 */
const advanceCliRetryState = (state: CliRetryState, passResult: CliPassResult): void => {
  const madeProgress = passResult.hadContent && passResult.source !== 'assistant_text';
  state.stalledPasses = madeProgress ? 0 : state.stalledPasses + 1;
  state.compactionBoost += passResult.compactionCount;
  const effectiveThreshold = CLI_STALL_THRESHOLD + Math.min(state.compactionBoost, CLI_MAX_COMPACTION_BOOST);
  checkCliStallCondition(state.stalledPasses, state.passNumber, state.lastDiagnostics, effectiveThreshold);
  state.lastDiagnostics = passResult.diagnostics;
};

/**
 * Simulates a single CLI pass with messages, returning the finalized result.
 */
const simulatePass = (messages: Record<string, unknown>[]): CliPassResult => {
  const acc: CliPassAccumulator = {
    compactionCount: 0, result: '', source: undefined, stopReason: undefined,
    sessionId: undefined, lastAssistantText: '', diagnostics: [],
  };
  for (const message of messages) {
    accumulateCliMessage(acc, message);
  }
  return finalizeCliPass(acc);
};

const createStalledPassResult = (compactionCount = 0): CliPassResult => ({
  compactionCount,
  diagnostics: [],
  hadContent: true,
  result: 'Just thinking...',
  sessionId: 'sess_test',
  source: 'assistant_text',
  stopReason: undefined,
});

// --- Tests ---

console.log(chalk.bold.cyan('\nCompaction-aware stall threshold smoke test\n'));

// Test 1: accumulateCliMessage increments compactionCount on compact_boundary
console.log(chalk.bold('Test 1: accumulateCliMessage increments compactionCount on compact_boundary'));
{
  const passResult = simulatePass([
    { type: 'system', subtype: 'compact_boundary', session_id: 'sess_1' },
    { type: 'system', subtype: 'compact_boundary', session_id: 'sess_1' },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'Stale output' }] }, session_id: 'sess_1' },
  ]);
  assert('compactionCount is 2', passResult.compactionCount === 2,
    `Expected 2, got ${passResult.compactionCount}`);
  assert('source is still assistant_text (compaction does not fix output)',
    passResult.source === 'assistant_text');
}

// Test 2: Without compaction — default threshold fires after 2 stalls
console.log(chalk.bold('\nTest 2: Without compaction, stall fires after 2 consecutive assistant_text passes'));
{
  const state: CliRetryState = { compactionBoost: 0, stalledPasses: 0, passNumber: 0, lastDiagnostics: [] };
  let thrownAtPass: number | null = null;

  for (let i = 0; i < 5; i++) {
    state.passNumber++;
    try {
      advanceCliRetryState(state, createStalledPassResult());
    } catch {
      thrownAtPass = state.passNumber;
      break;
    }
  }

  assert('Error thrown after exactly 2 passes', thrownAtPass === 2,
    `Expected passNumber=2, got ${thrownAtPass}`);
}

// Test 3: With 1 compact_boundary — effective threshold is 3
console.log(chalk.bold('\nTest 3: With 1 compaction event, effective threshold is 3'));
{
  const state: CliRetryState = { compactionBoost: 0, stalledPasses: 0, passNumber: 0, lastDiagnostics: [] };
  let thrownAtPass: number | null = null;

  for (let i = 0; i < 5; i++) {
    state.passNumber++;
    const compactionCount = i === 0 ? 1 : 0;
    try {
      advanceCliRetryState(state, createStalledPassResult(compactionCount));
    } catch {
      thrownAtPass = state.passNumber;
      break;
    }
  }

  assert('Error thrown after exactly 3 passes', thrownAtPass === 3,
    `Expected passNumber=3, got ${thrownAtPass}`);
}

// Test 4: With 6 compact_boundary events — boost capped at 4, effective threshold is 6
console.log(chalk.bold('\nTest 4: With 6 compaction events, boost capped at 4, effective threshold is 6'));
{
  const state: CliRetryState = { compactionBoost: 0, stalledPasses: 0, passNumber: 0, lastDiagnostics: [] };
  let thrownAtPass: number | null = null;

  for (let i = 0; i < 10; i++) {
    state.passNumber++;
    const compactionCount = i === 0 ? 6 : 0;
    try {
      advanceCliRetryState(state, createStalledPassResult(compactionCount));
    } catch {
      thrownAtPass = state.passNumber;
      break;
    }
  }

  assert('Error thrown after exactly 6 passes', thrownAtPass === 6,
    `Expected passNumber=6, got ${thrownAtPass}`);
  assert('compactionBoost is 6 (uncapped raw value)', state.compactionBoost === 6,
    `Expected 6, got ${state.compactionBoost}`);
}

// Test 5: compactionBoost persists across passes
console.log(chalk.bold('\nTest 5: compactionBoost accumulates across multiple passes'));
{
  const state: CliRetryState = { compactionBoost: 0, stalledPasses: 0, passNumber: 0, lastDiagnostics: [] };
  let thrownAtPass: number | null = null;

  for (let i = 0; i < 10; i++) {
    state.passNumber++;
    try {
      advanceCliRetryState(state, createStalledPassResult(1));
    } catch {
      thrownAtPass = state.passNumber;
      break;
    }
  }

  assert('compactionBoost accumulated to value at throw point', state.compactionBoost <= 6,
    `Got ${state.compactionBoost}`);
  assert('Error thrown after 6 passes (1 compaction/pass, capped at +4)', thrownAtPass === 6,
    `Expected passNumber=6, got ${thrownAtPass}`);
}

// Test 6: Successful pass resets stalledPasses regardless of compaction
console.log(chalk.bold('\nTest 6: Successful pass resets stalledPasses to 0'));
{
  const state: CliRetryState = { compactionBoost: 3, stalledPasses: 1, passNumber: 2, lastDiagnostics: [] };
  const goodResult: CliPassResult = {
    compactionCount: 0, diagnostics: [], hadContent: true,
    result: '{"action":"fix"}', sessionId: 'sess_ok',
    source: 'result', stopReason: undefined,
  };
  advanceCliRetryState(state, goodResult);
  assert('stalledPasses reset to 0 after successful pass', state.stalledPasses === 0,
    `Expected 0, got ${state.stalledPasses}`);
  assert('compactionBoost preserved after successful pass', state.compactionBoost === 3,
    `Expected 3, got ${state.compactionBoost}`);
}

// Test 7: Error message contains expected diagnostics
console.log(chalk.bold('\nTest 7: Stall error message includes diagnostics'));
{
  const state: CliRetryState = {
    compactionBoost: 0, stalledPasses: 1, passNumber: 2,
    lastDiagnostics: ['timeout after 30s', 'no structured output'],
  };
  let errorMessage = '';
  try {
    advanceCliRetryState(state, createStalledPassResult());
  } catch (error) {
    errorMessage = error instanceof Error ? error.message : '';
  }
  assert('Error includes "workload not decreasing"',
    errorMessage.includes('workload not decreasing'),
    `Got: ${errorMessage}`);
  assert('Error includes diagnostics',
    errorMessage.includes('timeout after 30s') && errorMessage.includes('no structured output'),
    `Got: ${errorMessage}`);
}

// Summary
console.log(
  chalk.bold(
    `\n${passed + failed} assertions: ${chalk.green(`${passed} passed`)}${failed > 0 ? `, ${chalk.red(`${failed} failed`)}` : ''}`
  )
);

if (failed > 0) {
  process.exit(1);
}
