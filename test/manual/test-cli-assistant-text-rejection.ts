/**
 * Manual smoke test: CLI retry loop rejects assistant_text as terminal pass result
 *
 * Run: nr test:manual -- test-cli-assistant-text-rejection
 *
 * Verifies:
 *   1. finalizeCliPass sets source to 'assistant_text' when only assistant text is present
 *   2. tryFinalizeCliPass guard rejects assistant_text source (returns undefined)
 *   3. tryFinalizeCliPass guard accepts 'result' source
 *   4. tryFinalizeCliPass guard accepts 'structured_output' source
 *   5. advanceCliRetryState counts assistant_text passes as stalls (does not reset counter)
 *   6. advanceCliRetryState resets stall counter for non-assistant_text content
 *   7. checkCliStallCondition throws after CLI_STALL_THRESHOLD consecutive stalls
 *   8. Observability hint '(assistant_text demoted)' appears in log for assistant_text passes
 *
 * @returns void
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
  diagnostics: string[];
  hadContent: boolean;
  result: string;
  sessionId: string | undefined;
  source: 'structured_output' | 'result' | 'assistant_text' | undefined;
  stopReason: string | undefined;
};

type CliRetryState = {
  sessionId?: string;
  stalledPasses: number;
  passNumber: number;
  lastDiagnostics: string[];
};

type CliPassAccumulator = {
  diagnostics: string[];
  lastAssistantText: string;
  result: string;
  sessionId: string | undefined;
  source: CliPassResult['source'];
  stopReason: string | undefined;
};

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
 * Mirrors finalizeCliPass in stage-agent.service.ts.
 */
const finalizeCliPass = (acc: CliPassAccumulator): CliPassResult => {
  const result = acc.result || (acc.lastAssistantText.trim() ? acc.lastAssistantText : '');
  const fallbackSource = acc.lastAssistantText.trim() ? 'assistant_text' as const : acc.source;
  const source = acc.result ? acc.source : fallbackSource;
  const hadContent = acc.lastAssistantText.trim().length > 0;
  return {
    result, source, stopReason: acc.stopReason,
    sessionId: acc.sessionId, hadContent, diagnostics: acc.diagnostics,
  };
};

/**
 * Mirrors tryFinalizeCliPass guard in stage-agent.service.ts (the fixed version).
 */
const tryFinalizeCliPass = (
  passResult: CliPassResult
): { content: string; sessionId?: string } | undefined => {
  if (!passResult.result || passResult.source === 'assistant_text') return undefined;
  return { content: passResult.result.trim(), sessionId: passResult.sessionId };
};

const CLI_STALL_THRESHOLD = DEFAULT_STALL_THRESHOLD;

/**
 * Mirrors checkCliStallCondition in stage-agent.service.ts.
 */
const checkCliStallCondition = (
  stalledPasses: number, passNumber: number, lastDiagnostics: string[]
): void => {
  if (stalledPasses < CLI_STALL_THRESHOLD) return;
  const detail = lastDiagnostics.length ? ` Diagnostics:\n${lastDiagnostics.join('\n')}` : '';
  const error = new Error(
    `Claude CLI finished without returning a result after ${passNumber} pass(es) — workload not decreasing.${detail}`
  );
  error.name = 'AIError';
  throw error;
};

/**
 * Mirrors advanceCliRetryState in stage-agent.service.ts (the fixed version).
 */
const advanceCliRetryState = (state: CliRetryState, passResult: CliPassResult): string => {
  const madeProgress = passResult.hadContent && passResult.source !== 'assistant_text';
  state.stalledPasses = madeProgress ? 0 : state.stalledPasses + 1;
  checkCliStallCondition(state.stalledPasses, state.passNumber, state.lastDiagnostics);
  state.lastDiagnostics = passResult.diagnostics;
  const sourceHint = passResult.source === 'assistant_text' ? ' (assistant_text demoted)' : '';
  return `Pass ${state.passNumber}: no usable result${sourceHint} — resuming session`;
};

/**
 * Simulates a single CLI pass: accumulate messages, then finalize.
 */
const simulatePass = (messages: Record<string, unknown>[]): CliPassResult => {
  const acc: CliPassAccumulator = {
    result: '', source: undefined, stopReason: undefined,
    sessionId: undefined, lastAssistantText: '', diagnostics: [],
  };
  for (const message of messages) {
    if (message.session_id) acc.sessionId = message.session_id as string;
    const assistantText = extractAssistantText(message);
    if (assistantText) acc.lastAssistantText = assistantText;
    const extracted = extractCliResultContent(message);
    if (extracted) {
      acc.result = extracted.result;
      acc.source = extracted.source;
      acc.stopReason = message.stop_reason as string | undefined;
    }
  }
  return finalizeCliPass(acc);
};

// --- Tests ---

console.log(chalk.bold.cyan('\nCLI assistant_text rejection smoke test\n'));

// Test 1: finalizeCliPass sets source to 'assistant_text' when only assistant text is present
console.log(chalk.bold('Test 1: finalizeCliPass sets source to assistant_text for prose-only pass'));
{
  const passResult = simulatePass([
    { type: 'assistant', message: { content: [{ type: 'text', text: 'Let me analyze...' }] }, session_id: 'sess_1' },
  ]);
  assert('source is assistant_text', passResult.source === 'assistant_text');
  assert('result contains the assistant text', passResult.result === 'Let me analyze...');
  assert('hadContent is true', passResult.hadContent === true);
  assert('sessionId is captured', passResult.sessionId === 'sess_1');
}

// Test 2: tryFinalizeCliPass guard rejects assistant_text source
console.log(chalk.bold('\nTest 2: tryFinalizeCliPass rejects assistant_text source'));
{
  const passResult = simulatePass([
    { type: 'assistant', message: { content: [{ type: 'text', text: 'Thinking deeply...' }] }, session_id: 'sess_2' },
  ]);
  const finalized = tryFinalizeCliPass(passResult);
  assert('Returns undefined for assistant_text pass', finalized === undefined,
    `Expected undefined, got ${JSON.stringify(finalized)}`);
}

// Test 3: tryFinalizeCliPass accepts 'result' source
console.log(chalk.bold('\nTest 3: tryFinalizeCliPass accepts result source'));
{
  const passResult = simulatePass([
    { type: 'result', subtype: 'success', result: '{"action":"fix"}', session_id: 'sess_3' },
  ]);
  const finalized = tryFinalizeCliPass(passResult);
  assert('Returns content for result pass', finalized !== undefined);
  assert('Content matches', finalized?.content === '{"action":"fix"}');
  assert('source is result', passResult.source === 'result');
}

// Test 4: tryFinalizeCliPass accepts 'structured_output' source
console.log(chalk.bold('\nTest 4: tryFinalizeCliPass accepts structured_output source'));
{
  const passResult = simulatePass([
    { type: 'result', subtype: 'success', structured_output: { action: 'fix' }, session_id: 'sess_4' },
  ]);
  const finalized = tryFinalizeCliPass(passResult);
  assert('Returns content for structured_output pass', finalized !== undefined);
  assert('Content is stringified JSON', finalized?.content === '{"action":"fix"}');
  assert('source is structured_output', passResult.source === 'structured_output');
}

// Test 5: advanceCliRetryState counts assistant_text passes as stalls
console.log(chalk.bold('\nTest 5: advanceCliRetryState counts assistant_text as stall'));
{
  const state: CliRetryState = { stalledPasses: 0, passNumber: 1, lastDiagnostics: [] };
  const passResult = simulatePass([
    { type: 'assistant', message: { content: [{ type: 'text', text: 'Still working...' }] }, session_id: 'sess_5' },
  ]);
  const logLine = advanceCliRetryState(state, passResult);
  assert('stalledPasses incremented to 1', state.stalledPasses === 1,
    `Expected 1, got ${state.stalledPasses}`);
  assert('Log includes (assistant_text demoted)', logLine.includes('(assistant_text demoted)'),
    `Got: ${logLine}`);
}

// Test 6: advanceCliRetryState increments stall counter for empty (non-assistant_text) pass
console.log(chalk.bold('\nTest 6: advanceCliRetryState increments stall counter for empty pass'));
{
  const state: CliRetryState = { stalledPasses: 0, passNumber: 1, lastDiagnostics: [] };
  const emptyPassResult: CliPassResult = {
    result: '', source: undefined, stopReason: undefined,
    sessionId: undefined, hadContent: false, diagnostics: [],
  };
  const logLine = advanceCliRetryState(state, emptyPassResult);
  assert('stalledPasses incremented to 1', state.stalledPasses === 1,
    `Expected 1, got ${state.stalledPasses}`);
  assert('Log does NOT include assistant_text demoted',
    !logLine.includes('(assistant_text demoted)'),
    `Got: ${logLine}`);
}

// Test 7: checkCliStallCondition throws after CLI_STALL_THRESHOLD consecutive stalls
console.log(chalk.bold('\nTest 7: Stall threshold triggers error after consecutive assistant_text passes'));
{
  const state: CliRetryState = { stalledPasses: 0, passNumber: 0, lastDiagnostics: [] };
  let thrownError: Error | undefined;

  // Simulate two consecutive assistant_text passes
  for (let i = 0; i < 3; i++) {
    state.passNumber++;
    const passResult = simulatePass([
      { type: 'assistant', message: { content: [{ type: 'text', text: `Thinking pass ${i + 1}` }] }, session_id: 'sess_7' },
    ]);
    const finalized = tryFinalizeCliPass(passResult);
    if (finalized) break;
    try {
      advanceCliRetryState(state, passResult);
    } catch (error) {
      thrownError = error as Error;
      break;
    }
  }

  assert('Error was thrown', thrownError !== undefined, 'Expected error but none thrown');
  assert('Error matches "workload not decreasing"',
    thrownError !== undefined && /workload not decreasing/.test(thrownError.message),
    `Got: ${thrownError?.message}`);
  assert('Error thrown after exactly 2 passes', state.passNumber === 2,
    `Expected passNumber=2, got ${state.passNumber}`);
  assert('stalledPasses reached threshold', state.stalledPasses === CLI_STALL_THRESHOLD,
    `Expected ${CLI_STALL_THRESHOLD}, got ${state.stalledPasses}`);
}

// Test 8: Full retry loop simulation — pass 1 assistant_text rejected, pass 2 result accepted
console.log(chalk.bold('\nTest 8: Full retry loop — assistant_text rejected on pass 1, result accepted on pass 2'));
{
  const passes: Record<string, unknown>[][] = [
    // Pass 1: only assistant text
    [{ type: 'assistant', message: { content: [{ type: 'text', text: 'Let me think...' }] }, session_id: 'sess_8' }],
    // Pass 2: valid result
    [{ type: 'result', subtype: 'success', result: '{"action":"fix"}', session_id: 'sess_8' }],
  ];

  const state: CliRetryState = { stalledPasses: 0, passNumber: 0, lastDiagnostics: [] };
  let finalResult: { content: string; sessionId?: string } | undefined;
  const logLines: string[] = [];

  for (const passMessages of passes) {
    state.passNumber++;
    const passResult = simulatePass(passMessages);
    if (passResult.sessionId) state.sessionId = passResult.sessionId;

    const completed = tryFinalizeCliPass(passResult);
    if (completed) {
      finalResult = completed;
      break;
    }
    const logLine = advanceCliRetryState(state, passResult);
    logLines.push(logLine);
  }

  assert('Final result is defined', finalResult !== undefined);
  assert('Final result content is from pass 2', finalResult?.content === '{"action":"fix"}',
    `Got: ${finalResult?.content}`);
  assert('Session ID forwarded', state.sessionId === 'sess_8');
  assert('Pass 1 log shows assistant_text demoted',
    logLines.some(l => l.includes('(assistant_text demoted)')),
    `Log lines: ${JSON.stringify(logLines)}`);
  assert('Loop completed on pass 2', state.passNumber === 2,
    `Expected passNumber=2, got ${state.passNumber}`);
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
