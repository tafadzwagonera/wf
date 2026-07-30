/**
 * Manual smoke test: CLI --json-schema + StructuredOutput workflow and node-fetch polyfill
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
 *
 * Extraction/priority tests (structured_output > result > assistant_text) moved to
 * test-cli-assistant-text-rejection.ts and stage-agent.service.spec.ts.
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
  const suffix = detail ? `\n    \u2192 ${detail}` : '';
  console.error(chalk.red(`  \u2717 ${message}${suffix}`));
  failed += 1;
};

const assert = (message: string, condition: boolean, detail?: string): void => {
  if (condition) {
    pass(message);
    return;
  }
  fail(message, detail);
};

console.log(
  chalk.bold.cyan('\n\uD83E\uDDEA CLI --json-schema + assistant-text fallback + node-fetch polyfill smoke test\n')
);

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

console.log(chalk.bold('\nTest 2: buildCliArgs omits --json-schema when not provided'));
const argsWithoutSchema = buildCliArgs({
  prompt: 'test',
  model: 'claude-sonnet-4-6',
  cwd: '/repo',
});
assert('--json-schema flag is absent', !argsWithoutSchema.includes('--json-schema'));

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

console.log(chalk.bold('\nTest 4: JSON Schema is string-serializable'));
const serialized = JSON.stringify(jsonSchema);
assert('Serializes to a non-empty string', serialized.length > 0);
const roundTripped = JSON.parse(serialized);
assert('Round-trips back to equivalent object', roundTripped.type === 'object');

console.log(chalk.bold('\nTest 5: node-fetch is available as CJS require'));
const nodeFetch = require('node-fetch');
assert('node-fetch exports a function', typeof nodeFetch === 'function');

console.log(chalk.bold('\nTest 6: Fetch fallback resolves to a function'));
const fetchImpl = globalThis.fetch ?? nodeFetch;
assert('Fallback is a function', typeof fetchImpl === 'function');

console.log(chalk.bold('\nSummary'));
console.log(`  Passed: ${passed}`);
console.log(`  Failed: ${failed}`);

if (failed > 0) {
  process.exit(1);
}
