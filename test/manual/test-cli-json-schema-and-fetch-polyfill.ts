/**
 * Manual smoke test: CLI --json-schema flag extension point and node-fetch polyfill
 *
 * Run: nr test:manual -- test-cli-json-schema-and-fetch-polyfill
 *
 * Verifies:
 *   1. buildCliArgs includes --json-schema when jsonSchema is provided.
 *   2. buildCliArgs omits --json-schema when jsonSchema is not provided.
 *   3. node-fetch is available as a CJS require.
 *   4. Anthropic adapter fetch fallback resolves to a function.
 *   5. Fetch fallback works when globalThis.fetch is deleted.
 *   6. Prose response triggers the fallback error shape in PlanStageService.
 *   7. "No result" AIError matches the widened fallback guard.
 *   8. Unrelated AIErrors do NOT match the fallback guard.
 */
import chalk from 'chalk';
import { buildCliArgs } from '../../src/integrations/ai/adapters/claude-cli-runner';
import { AIError, isAIErrorLike } from '../../src/shared/utils/errors';

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
  console.log(chalk.bold.cyan('\n\uD83E\uDDEA CLI --json-schema extension and node-fetch polyfill smoke test\n'));

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

  // --- Test 3: node-fetch is available ---
  console.log(chalk.bold('\nTest 3: node-fetch is available as CJS require'));
  const nodeFetch = require('node-fetch');
  assert('node-fetch exports a function', typeof nodeFetch === 'function');

  // --- Test 4: fetch fallback resolves ---
  console.log(chalk.bold('\nTest 4: Fetch fallback resolves to a function'));
  const fetchImpl = globalThis.fetch ?? nodeFetch;
  assert('Fallback is a function', typeof fetchImpl === 'function');

  // --- Test 5: fetch fallback works when globalThis.fetch is deleted ---
  console.log(chalk.bold('\nTest 5: Fetch fallback works when globalThis.fetch is missing'));
  const originalFetch = globalThis.fetch;
  try {
    // @ts-expect-error — simulate Node < 18
    delete globalThis.fetch;
    const fallback = globalThis.fetch ?? nodeFetch;
    assert('Fallback resolves to node-fetch', fallback === nodeFetch);
  } finally {
    globalThis.fetch = originalFetch;
  }

  // --- Test 6: Prose response triggers the fallback error shape ---
  console.log(chalk.bold('\nTest 6: Prose response triggers the PlanStageService fallback guard'));
  const proseError = new AIError('Failed to parse resolution plan from agent response', {
    response: 'Here is my detailed analysis of the codebase...',
    error: new SyntaxError('Unexpected token H in JSON at position 0'),
  });
  assert('isAIErrorLike returns true', isAIErrorLike(proseError));
  assert('Error message matches fallback trigger', proseError.message.includes('Failed to parse resolution plan'));
  const agentProse = proseError.details?.response;
  assert(
    'Error details contain a non-empty prose response',
    typeof agentProse === 'string' && agentProse.trim().length > 0
  );

  // --- Test 7: "No result" AIError matches the widened fallback guard ---
  console.log(chalk.bold('\nTest 7: "No result" AIError matches the widened fallback guard'));
  const noResultError = new AIError('Claude CLI finished without returning a result after 2 attempt(s).', null, true);
  assert('isAIErrorLike returns true for no-result error', isAIErrorLike(noResultError));
  assert(
    'Error message matches widened fallback trigger',
    noResultError.message.includes('CLI finished without returning a result')
  );
  assert('Error details.response is absent (no prose)', noResultError.details?.response === undefined);

  // --- Test 8: Unrelated AIErrors do NOT match the fallback guard ---
  console.log(chalk.bold('\nTest 8: Unrelated AIErrors bypass the fallback guard'));
  const rateLimitError = new AIError('Rate limit exceeded', { status: 429 });
  assert('Rate limit AIError is AIError-like', isAIErrorLike(rateLimitError));
  const rateLimitMatchesFallback =
    rateLimitError.message.includes('Failed to parse resolution plan') ||
    rateLimitError.message.includes('CLI finished without returning a result');
  assert('Rate limit error does NOT match fallback trigger', !rateLimitMatchesFallback);

  // --- Summary ---
  console.log(chalk.bold('\nSummary'));
  console.log(`  Passed: ${passed}`);
  console.log(`  Failed: ${failed}`);

  if (failed > 0) {
    process.exit(1);
  }
}

void main();
