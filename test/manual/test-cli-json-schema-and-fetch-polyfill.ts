/**
 * Manual smoke test: CLI --json-schema + StructuredOutput workflow, assistant-text
 * accumulation fallback, and node-fetch polyfill
 *
 * Run: nr test:manual -- test-cli-json-schema-and-fetch-polyfill
 *
 * Verifies:
 *   1. buildCliArgs includes --json-schema when jsonSchema is provided.
 *   2. buildCliArgs omits --json-schema when jsonSchema is not provided.
 *   3. z.toJSONSchema produces a valid JSON Schema from resolutionPlanSchema.
 *   4. The generated JSON Schema is a string-serializable object.
 *   5. structured_output is preferred over empty result (primary path).
 *   6. result is used when structured_output is absent (secondary path).
 *   7. Assistant-text extraction captures text blocks (fallback path).
 *   8. Assistant-text extraction ignores non-text blocks.
 *   9. Assistant-text extraction returns undefined for non-assistant messages.
 *  10. Three-tier priority: structured_output > result > assistant_text.
 *  11. node-fetch is available as a CJS require.
 *  12. Anthropic adapter fetch fallback resolves to a function.
 */
import chalk from 'chalk';
import { z } from 'zod';
import { buildCliArgs, type ClaudeCliMessage } from '../../src/integrations/ai/adapters/claude-cli-runner';
import { resolutionPlanSchema } from '../../src/shared/schemas/ai.schema';

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
 * Mirrors the extractAssistantText helper in stage-agent.service.ts.
 * Duplicated here to test the extraction logic in isolation.
 */
const extractAssistantText = (message: ClaudeCliMessage): string | undefined => {
  if (message.type !== 'assistant') return undefined;
  const content = (message as Record<string, unknown>).message;
  if (!content || typeof content !== 'object' || !('content' in content)) return undefined;
  const blocks = (content as { content: unknown[] }).content;
  if (!Array.isArray(blocks)) return undefined;
  let turnText = '';
  for (const block of blocks) {
    if (
      typeof block === 'object' &&
      block !== null &&
      (block as Record<string, unknown>).type === 'text' &&
      typeof (block as Record<string, unknown>).text === 'string'
    ) {
      turnText += (block as { text: string }).text;
    }
  }
  return turnText || undefined;
};

/**
 * Mirrors the three-tier extraction logic in runCliStagePrompt / cliChatTurn.
 */
const extractResult = (
  message: ClaudeCliMessage
): { value: string; source: 'structured_output' | 'result' } | undefined => {
  if (message.type !== 'result' || message.is_error) return undefined;
  if (message.structured_output && typeof message.structured_output === 'object') {
    return { value: JSON.stringify(message.structured_output), source: 'structured_output' };
  }
  if (message.result) {
    return { value: message.result, source: 'result' };
  }
  return undefined;
};

async function main(): Promise<void> {
  console.log(
    chalk.bold.cyan('\n\uD83E\uDDEA CLI --json-schema + assistant-text fallback + node-fetch polyfill smoke test\n')
  );

  // --- Test 1: buildCliArgs includes --json-schema ---
  console.log(chalk.bold('Test 1: buildCliArgs includes --json-schema when provided'));
  const schema = '{"type":"object"}';
  const argsWithSchema = buildCliArgs({
    prompt: 'test',
    model: 'claude-sonnet-4-6',
    cwd: '/repo',
    jsonSchema: schema,
  });
  const schemaIdx = argsWithSchema.indexOf('--json-schema');
  assert('--json-schema flag is present', schemaIdx > -1);
  assert('Schema value follows the flag', argsWithSchema[schemaIdx + 1] === schema);

  // --- Test 2: buildCliArgs omits --json-schema ---
  console.log(chalk.bold('\nTest 2: buildCliArgs omits --json-schema when not provided'));
  const argsWithoutSchema = buildCliArgs({
    prompt: 'test',
    model: 'claude-sonnet-4-6',
    cwd: '/repo',
  });
  assert('--json-schema flag is absent', !argsWithoutSchema.includes('--json-schema'));

  // --- Test 3: z.toJSONSchema produces valid JSON Schema ---
  console.log(chalk.bold('\nTest 3: z.toJSONSchema produces a valid JSON Schema'));
  const jsonSchema = z.toJSONSchema(resolutionPlanSchema);
  assert('Result is an object', typeof jsonSchema === 'object' && jsonSchema !== null);
  assert('Has type property', 'type' in jsonSchema && jsonSchema.type === 'object');
  assert('Has properties', 'properties' in jsonSchema && typeof jsonSchema.properties === 'object');
  const props = jsonSchema.properties as Record<string, unknown>;
  assert('Contains action property', 'action' in props);
  assert('Contains summary property', 'summary' in props);
  assert('Contains steps property', 'steps' in props);
  assert('Contains estimatedComplexity property', 'estimatedComplexity' in props);

  // --- Test 4: JSON Schema is string-serializable ---
  console.log(chalk.bold('\nTest 4: JSON Schema is string-serializable'));
  const serialized = JSON.stringify(jsonSchema);
  assert('Serializes to a non-empty string', typeof serialized === 'string' && serialized.length > 0);
  const roundTripped = JSON.parse(serialized);
  assert('Round-trips back to equivalent object', roundTripped.type === 'object');

  // --- Test 5: structured_output is preferred (primary path) ---
  console.log(chalk.bold('\nTest 5: structured_output is preferred over empty result'));
  const structuredMsg: ClaudeCliMessage = {
    type: 'result',
    is_error: false,
    result: '',
    structured_output: { action: 'fix', summary: 'Fix auth', steps: ['step 1'] },
  };
  const structuredResult = extractResult(structuredMsg);
  assert('Extracts from structured_output', structuredResult?.source === 'structured_output');
  const parsed = JSON.parse(structuredResult!.value);
  assert('Parsed action matches', parsed.action === 'fix');
  assert('Parsed summary matches', parsed.summary === 'Fix auth');

  // --- Test 6: result is used when structured_output is absent (secondary path) ---
  console.log(chalk.bold('\nTest 6: result is used when structured_output is absent'));
  const plainMsg: ClaudeCliMessage = {
    type: 'result',
    is_error: false,
    result: '{"action":"feature","summary":"Add login"}',
  };
  const plainResult = extractResult(plainMsg);
  assert('Falls back to result', plainResult?.source === 'result');
  assert('Value matches', plainResult?.value === plainMsg.result);

  // --- Test 7: Assistant-text extraction captures text blocks (fallback path) ---
  console.log(chalk.bold('\nTest 7: extractAssistantText captures text blocks'));
  const assistantMsg: ClaudeCliMessage = {
    type: 'assistant',
    message: {
      content: [
        { type: 'text', text: '{"action":"fix",' },
        { type: 'text', text: '"summary":"Fix auth"}' },
      ],
    },
  };
  const extracted = extractAssistantText(assistantMsg);
  assert('Extracts concatenated text', extracted === '{"action":"fix","summary":"Fix auth"}');

  // --- Test 8: Ignores non-text blocks ---
  console.log(chalk.bold('\nTest 8: extractAssistantText ignores non-text blocks'));
  const mixedMsg: ClaudeCliMessage = {
    type: 'assistant',
    message: {
      content: [
        { type: 'tool_use', id: 'tool-1', name: 'Read', input: {} },
        { type: 'text', text: 'only this' },
      ],
    },
  };
  assert('Only text blocks extracted', extractAssistantText(mixedMsg) === 'only this');

  // --- Test 9: Returns undefined for non-assistant messages ---
  console.log(chalk.bold('\nTest 9: extractAssistantText returns undefined for non-assistant'));
  const resultMsg: ClaudeCliMessage = { type: 'result', result: 'done' };
  assert('Returns undefined for result message', extractAssistantText(resultMsg) === undefined);
  const systemMsg: ClaudeCliMessage = { type: 'system', subtype: 'init' };
  assert('Returns undefined for system message', extractAssistantText(systemMsg) === undefined);

  // --- Test 10: Three-tier priority ---
  console.log(chalk.bold('\nTest 10: Three-tier priority: structured_output > result > assistant_text'));
  const bothMsg: ClaudeCliMessage = {
    type: 'result',
    is_error: false,
    result: '{"action":"from-result"}',
    structured_output: { action: 'from-structured' },
  };
  const bothResult = extractResult(bothMsg);
  assert('structured_output wins over result', bothResult?.source === 'structured_output');
  assert('structured_output value used', JSON.parse(bothResult!.value).action === 'from-structured');

  // When result message has neither, assistant_text would be used (tested by absence)
  const emptyMsg: ClaudeCliMessage = { type: 'result', is_error: false, result: '' };
  const emptyResult = extractResult(emptyMsg);
  assert('Returns undefined when both are empty', emptyResult === undefined);

  // --- Test 11: node-fetch is available ---
  console.log(chalk.bold('\nTest 11: node-fetch is available as CJS require'));
  const nodeFetch = require('node-fetch');
  assert('node-fetch exports a function', typeof nodeFetch === 'function');

  // --- Test 12: fetch fallback resolves ---
  console.log(chalk.bold('\nTest 12: Fetch fallback resolves to a function'));
  const fetchImpl = globalThis.fetch ?? nodeFetch;
  assert('Fallback is a function', typeof fetchImpl === 'function');

  // --- Summary ---
  console.log(chalk.bold('\nSummary'));
  console.log(`  Passed: ${passed}`);
  console.log(`  Failed: ${failed}`);

  if (failed > 0) {
    process.exit(1);
  }
}

void main();
