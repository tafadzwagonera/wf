/**
 * Smoke test: CLI execution mode in review schema and provenance resolution.
 *
 * Validates that:
 * 1. codeReviewSchema accepts 'cli' as a valid executionMode
 * 2. codeReviewSchema rejects unknown executionMode values
 * 3. The 'cli' execution mode is distinct from 'agent' and 'standard'
 * 4. processedCodeReviewSchema accepts 'cli' executionMode at the wrapper level
 */

import assert from 'node:assert/strict';
import chalk from 'chalk';
import { codeReviewSchema, processedCodeReviewSchema } from '../../src/shared/schemas/review.schema';

let passed = 0;
let failed = 0;

const test = (name: string, fn: () => void) => {
  try {
    fn();
    console.log(chalk.green(`  PASS  ${name}`));
    passed++;
  } catch (e: any) {
    console.log(chalk.red(`  FAIL  ${name}: ${e.message}`));
    failed++;
  }
};

const validReview = {
  summary: 'Looks good',
  issues: [],
  suggestions: [],
  approved: true,
};

// --- 1. codeReviewSchema executionMode enum ---
console.log(chalk.bold('\n--- codeReviewSchema executionMode enum ---'));

test('accepts executionMode: standard', () => {
  const result = codeReviewSchema.safeParse({ ...validReview, executionMode: 'standard' });
  assert.ok(result.success, 'Expected parse to succeed for standard');
});

test('accepts executionMode: agent', () => {
  const result = codeReviewSchema.safeParse({ ...validReview, executionMode: 'agent' });
  assert.ok(result.success, 'Expected parse to succeed for agent');
});

test('accepts executionMode: cli', () => {
  const result = codeReviewSchema.safeParse({ ...validReview, executionMode: 'cli' });
  assert.ok(result.success, 'Expected parse to succeed for cli');
});

test('accepts omitted executionMode (optional)', () => {
  const result = codeReviewSchema.safeParse(validReview);
  assert.ok(result.success, 'Expected parse to succeed without executionMode');
});

test('rejects executionMode: unknown', () => {
  const result = codeReviewSchema.safeParse({ ...validReview, executionMode: 'unknown' });
  assert.ok(!result.success, 'Expected parse to fail for unknown');
});

test('rejects executionMode: completion', () => {
  const result = codeReviewSchema.safeParse({ ...validReview, executionMode: 'completion' });
  assert.ok(!result.success, 'Expected parse to fail for completion');
});

// --- 2. Enum values are distinct ---
console.log(chalk.bold('\n--- Execution mode distinctness ---'));

test('cli, agent, and standard are all distinct parsed values', () => {
  const cli = codeReviewSchema.parse({ ...validReview, executionMode: 'cli' });
  const agent = codeReviewSchema.parse({ ...validReview, executionMode: 'agent' });
  const standard = codeReviewSchema.parse({ ...validReview, executionMode: 'standard' });
  assert.notEqual(cli.executionMode, agent.executionMode);
  assert.notEqual(cli.executionMode, standard.executionMode);
  assert.notEqual(agent.executionMode, standard.executionMode);
});

// --- 3. processedCodeReviewSchema wrapper ---
console.log(chalk.bold('\n--- processedCodeReviewSchema wrapper ---'));

test('processedCodeReviewSchema accepts cli executionMode', () => {
  const result = processedCodeReviewSchema.safeParse({
    review: { ...validReview, executionMode: 'cli' },
    presentation: { issueRows: [], unmatchedSuggestions: [] },
  });
  assert.ok(result.success, 'Expected processedCodeReviewSchema to accept cli');
});

test('processedCodeReviewSchema rejects invalid executionMode', () => {
  const result = processedCodeReviewSchema.safeParse({
    review: { ...validReview, executionMode: 'invalid' },
    presentation: { issueRows: [], unmatchedSuggestions: [] },
  });
  assert.ok(!result.success, 'Expected processedCodeReviewSchema to reject invalid');
});

// --- Summary ---
console.log(chalk.bold(`\n${passed} passed, ${failed} failed`));
if (failed > 0) process.exit(1);
