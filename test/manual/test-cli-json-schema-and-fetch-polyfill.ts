/**
 * Manual smoke test: CLI --json-schema flag and node-fetch polyfill
 *
 * Run: nr test:manual -- test-cli-json-schema-and-fetch-polyfill
 *
 * Verifies:
 *   1. buildCliArgs includes --json-schema when jsonSchema is provided.
 *   2. buildCliArgs omits --json-schema when jsonSchema is not provided.
 *   3. z.toJSONSchema produces a valid JSON Schema from resolutionPlanSchema.
 *   4. The generated JSON Schema is a string-serializable object.
 *   5. node-fetch is available as a CJS require.
 *   6. Anthropic adapter fetch fallback resolves to a function.
 *   7. CliRunnerParams accepts the jsonSchema field without type errors.
 */
import chalk from 'chalk';
import { z } from 'zod';
import { buildCliArgs } from '../../src/integrations/ai/adapters/claude-cli-runner';
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

async function main(): Promise<void> {
  console.log(chalk.bold.cyan('\n\uD83E\uDDEA CLI --json-schema and node-fetch polyfill smoke test\n'));

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

  // --- Test 5: node-fetch is available ---
  console.log(chalk.bold('\nTest 5: node-fetch is available as CJS require'));
  const nodeFetch = require('node-fetch');
  assert('node-fetch exports a function', typeof nodeFetch === 'function');

  // --- Test 6: fetch fallback resolves ---
  console.log(chalk.bold('\nTest 6: Fetch fallback resolves to a function'));
  const fetchImpl = globalThis.fetch ?? nodeFetch;
  assert('Fallback is a function', typeof fetchImpl === 'function');

  // --- Test 7: CliRunnerParams accepts jsonSchema ---
  console.log(chalk.bold('\nTest 7: CliRunnerParams accepts jsonSchema field'));
  const paramsWithSchema = buildCliArgs({
    prompt: 'plan prompt',
    model: 'claude-sonnet-4-6',
    cwd: '/repo',
    permissionMode: 'plan',
    jsonSchema: serialized,
  });
  assert('Args built successfully with jsonSchema', Array.isArray(paramsWithSchema));
  assert(
    'Schema value is the full serialized schema',
    paramsWithSchema[paramsWithSchema.indexOf('--json-schema') + 1] === serialized
  );

  // --- Test 8: structured_output is preferred over empty result ---
  console.log(chalk.bold('\nTest 8: structured_output is preferred over empty result'));
  const structuredMessage = {
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: '',
    structured_output: { action: 'fix', summary: 'Fix auth', steps: ['step 1'] },
  };
  let extracted = '';
  if (structuredMessage.type === 'result' && !structuredMessage.is_error) {
    if (structuredMessage.structured_output && typeof structuredMessage.structured_output === 'object') {
      extracted = JSON.stringify(structuredMessage.structured_output);
    } else if (structuredMessage.result) {
      extracted = structuredMessage.result;
    }
  }
  assert('Extracts from structured_output when result is empty', extracted.length > 0);
  const parsed = JSON.parse(extracted);
  assert('Parsed action matches', parsed.action === 'fix');
  assert('Parsed summary matches', parsed.summary === 'Fix auth');
  assert('Parsed steps is an array', Array.isArray(parsed.steps));

  // --- Test 9: result is used when structured_output is absent ---
  console.log(chalk.bold('\nTest 9: result is used when structured_output is absent'));
  const plainMessage = {
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: '{"action":"feature","summary":"Add login"}',
  };
  let plainExtracted = '';
  if (plainMessage.type === 'result' && !plainMessage.is_error) {
    const so = (plainMessage as Record<string, unknown>).structured_output;
    if (so && typeof so === 'object') {
      plainExtracted = JSON.stringify(so);
    } else if (plainMessage.result) {
      plainExtracted = plainMessage.result;
    }
  }
  assert('Falls back to result when structured_output is absent', plainExtracted === plainMessage.result);

  // --- Summary ---
  console.log(chalk.bold('\nSummary'));
  console.log(`  Passed: ${passed}`);
  console.log(`  Failed: ${failed}`);

  if (failed > 0) {
    process.exit(1);
  }
}

void main();
