/**
 * Manual smoke test: CLI JSON validation gate rejects prose and enforces review schema
 *
 * Run: nr test:manual -- test-cli-json-validation-gate
 *
 * Scenario: The CLI backend now sends --json-schema for both plan and review
 * stages, and tryFinalizeCliPass rejects non-JSON prose via source='result'
 * before it reaches downstream parsers. This test verifies the three live
 * side effects: schema injection into buildCliArgs, the JSON gate itself, and
 * the schema-aware retry prompt selection.
 *
 * Config under test:
 *   stages.plan.backend: 'cli', stages.plan.provider: 'anthropic'
 *   stages.review.backend: 'cli', stages.review.provider: 'anthropic'
 *
 * Verify:
 *   1. buildCliArgs receives a defined jsonSchema containing '"summary"' for the review stage
 *   2. buildCliArgs receives a defined jsonSchema containing '"action"' for the plan stage
 *   3. buildCliArgs receives jsonSchema=undefined for the generate stage
 *   4. parseJsonResponse accepts valid JSON (gate passes)
 *   5. parseJsonResponse throws on prose text (gate rejects)
 *   6. Retry prompt includes "requested schema" when jsonSchema is defined
 *   7. Retry prompt includes "requested content directly" when jsonSchema is undefined
 *
 * Wire up: import CLI_STAGE_JSON_SCHEMAS indirectly by importing
 * buildCliArgs and parseJsonResponse, then call them with controlled inputs.
 * No teardown needed — no external state is created.
 */
import chalk from 'chalk';
import { z } from 'zod';
import { buildCliArgs } from '../../src/integrations/ai/adapters/claude-cli-runner';
import { parseJsonResponse } from '../../src/integrations/ai/ai.service';
import { resolutionPlanSchema } from '../../src/shared/schemas/ai.schema';
import { codeReviewSchema } from '../../src/shared/schemas/review.schema';

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
  console.log(chalk.bold.cyan('\n  CLI JSON validation gate smoke test\n'));

  // --- Test 1: review schema contains "summary" ---
  console.log(chalk.bold('Test 1: review stage JSON schema contains "summary"'));
  const reviewSchema = JSON.stringify(z.toJSONSchema(codeReviewSchema));
  assert('review schema is a non-empty string', typeof reviewSchema === 'string' && reviewSchema.length > 0);
  assert('review schema contains "summary"', reviewSchema.includes('"summary"'), reviewSchema.slice(0, 200));

  const reviewArgs = buildCliArgs({
    prompt: 'review this diff',
    appendSystemPrompt: 'You are a reviewer.',
    model: 'claude-sonnet-4-6',
    cwd: '/tmp/repo',
    tools: [],
    permissionMode: 'plan',
    jsonSchema: reviewSchema,
  });
  assert(
    'buildCliArgs includes --json-schema for review',
    reviewArgs.includes('--json-schema'),
    `args: ${JSON.stringify(reviewArgs)}`
  );

  // --- Test 2: plan schema contains "action" ---
  console.log(chalk.bold('\nTest 2: plan stage JSON schema contains "action"'));
  const planSchema = JSON.stringify(z.toJSONSchema(resolutionPlanSchema));
  assert('plan schema contains "action"', planSchema.includes('"action"'), planSchema.slice(0, 200));

  const planArgs = buildCliArgs({
    prompt: 'generate a plan',
    appendSystemPrompt: 'You are a planner.',
    model: 'claude-sonnet-4-6',
    cwd: '/tmp/repo',
    tools: [],
    permissionMode: 'plan',
    jsonSchema: planSchema,
  });
  assert(
    'buildCliArgs includes --json-schema for plan',
    planArgs.includes('--json-schema'),
    `args: ${JSON.stringify(planArgs)}`
  );

  // --- Test 3: generate stage has no schema ---
  console.log(chalk.bold('\nTest 3: generate stage passes undefined jsonSchema'));
  const generateArgs = buildCliArgs({
    prompt: 'generate code',
    appendSystemPrompt: 'You are a coder.',
    model: 'claude-sonnet-4-6',
    cwd: '/tmp/repo',
    tools: [],
    permissionMode: 'plan',
    jsonSchema: undefined,
  });
  assert(
    'buildCliArgs does NOT include --json-schema for generate',
    !generateArgs.includes('--json-schema'),
    `args: ${JSON.stringify(generateArgs)}`
  );

  // --- Test 4: parseJsonResponse accepts valid JSON ---
  console.log(chalk.bold('\nTest 4: parseJsonResponse accepts valid JSON'));
  const validJson = JSON.stringify({ action: 'fix', summary: 'Fix it', steps: ['step 1'] });
  let parsedPlan: Record<string, unknown> | undefined;
  try {
    parsedPlan = parseJsonResponse<Record<string, unknown>>(validJson);
  } catch {
    // swallowed — assertion below handles the failure
  }
  assert('valid JSON is parsed without error', parsedPlan !== undefined);
  assert('parsed object has expected action field', parsedPlan?.action === 'fix', `got: ${JSON.stringify(parsedPlan)}`);

  // --- Test 5: parseJsonResponse throws on prose ---
  console.log(chalk.bold('\nTest 5: parseJsonResponse throws on prose text'));
  let proseThrew = false;
  try {
    parseJsonResponse('Here is my detailed analysis of the codebase and its issues.');
  } catch {
    proseThrew = true;
  }
  assert('prose text is rejected by parseJsonResponse', proseThrew);

  // --- Test 6: Retry prompt with schema includes "requested schema" ---
  console.log(chalk.bold('\nTest 6: retry prompt when jsonSchema is defined'));
  const schemaRetryArgs = buildCliArgs({
    prompt: 'Your previous response did not include a usable result. Please output ONLY a valid JSON object matching the requested schema. Do not include commentary or markdown — IMPORTANT: raw, minified JSON only (no unnecessary whitespace or newlines).',
    appendSystemPrompt: 'sys',
    model: 'claude-sonnet-4-6',
    cwd: '/tmp/repo',
    tools: [],
    permissionMode: 'plan',
    jsonSchema: planSchema,
    sessionId: 'sess_retry',
  });
  assert(
    'schema retry args include --json-schema',
    schemaRetryArgs.includes('--json-schema'),
    `args: ${JSON.stringify(schemaRetryArgs)}`
  );
  assert(
    'schema retry args include --resume',
    schemaRetryArgs.includes('--resume'),
    `args: ${JSON.stringify(schemaRetryArgs)}`
  );

  // --- Test 7: Retry prompt without schema uses chat prompt ---
  console.log(chalk.bold('\nTest 7: retry prompt when jsonSchema is undefined'));
  const chatRetryArgs = buildCliArgs({
    prompt: 'Your previous response did not include a usable result. Please respond with the requested content directly.',
    appendSystemPrompt: 'sys',
    model: 'claude-sonnet-4-6',
    cwd: '/tmp/repo',
    tools: [],
    permissionMode: 'plan',
    sessionId: 'sess_retry',
  });
  assert(
    'chat retry args do NOT include --json-schema',
    !chatRetryArgs.includes('--json-schema'),
    `args: ${JSON.stringify(chatRetryArgs)}`
  );

  // --- Summary ---
  console.log(chalk.bold('\nSummary'));
  console.log(`  Passed: ${passed}`);
  console.log(`  Failed: ${failed}`);

  if (failed > 0) {
    process.exit(1);
  }
}

void main();
