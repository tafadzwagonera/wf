/**
 * Smoke test: Zod schema migration and AppError hierarchy.
 *
 * Validates that:
 * 1. Zod schemas parse valid data and reject invalid data
 * 2. AppError replaces AgentError with identical behaviour
 * 3. Error subclass names, codes, and recoverability are preserved
 * 4. isAIErrorLike duck-typing guard works across boundaries
 * 5. Re-export facades keep downstream imports working
 * 6. ERROR_CODE const object mirrors the legacy ErrorCode enum values
 */

import assert from 'node:assert/strict';
import chalk from 'chalk';

// --- Schema imports ---
import { resolutionPlanSchema } from '../../src/shared/schemas/ai.schema';
import { verificationStepSchema } from '../../src/shared/schemas/verification.schema';
import { errorCodeSchema, ERROR_CODE } from '../../src/shared/schemas/error.schema';
import { codeIssueSchema, codeReviewSchema } from '../../src/shared/schemas/review.schema';
import { branchInfoSchema } from '../../src/shared/schemas/git.schema';
import { ticketTypeSchema } from '../../src/shared/schemas/ticket.schema';

// --- Error hierarchy imports (new location) ---
import {
  AppError,
  ApiError,
  AIError,
  GitError,
  JiraApiError,
  ValidationError,
  WorkflowParseError,
  ExecutionError,
  StateError,
  UserCancelledError,
  ConfigurationError,
  FileSystemError,
  isAIErrorLike,
} from '../../src/shared/errors/app.error';

// --- Re-export facade imports (backward compat) ---
import {
  AIError as FacadeAIError,
  isAIErrorLike as facadeIsAIErrorLike,
  ErrorCode,
} from '../../src/shared/utils/errors';

// --- Type re-export imports ---
import type { ResolutionPlan } from '../../src/shared/types/ai.types';
import type { VerificationStep } from '../../src/shared/types/verification.types';
import type { CodeIssue } from '../../src/shared/types/review.types';
import type { BranchInfo } from '../../src/shared/types/git.types';

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

// --- 1. Schema parsing ---
console.log(chalk.bold('\n--- Zod schema parsing ---'));

test('resolutionPlanSchema accepts valid plan', () => {
  const plan: ResolutionPlan = {
    action: 'fix',
    summary: 'Fix the bug',
    steps: ['Step 1', 'Step 2'],
    estimatedComplexity: 'low',
  };
  const result = resolutionPlanSchema.safeParse(plan);
  assert.ok(result.success, 'Expected parse to succeed');
});

test('resolutionPlanSchema rejects invalid action', () => {
  const result = resolutionPlanSchema.safeParse({
    action: 'invalid',
    summary: 'x',
    steps: [],
    estimatedComplexity: 'low',
  });
  assert.ok(!result.success, 'Expected parse to fail');
});

test('verificationStepSchema accepts valid step', () => {
  const step: VerificationStep = {
    id: 'lint',
    run: 'npm run lint',
    policy: 'enforced',
  };
  const result = verificationStepSchema.safeParse(step);
  assert.ok(result.success, 'Expected parse to succeed');
});

test('codeIssueSchema accepts valid issue', () => {
  const issue: CodeIssue = {
    severity: 'error',
    message: 'Unused variable',
    file: 'src/index.ts',
    line: 42,
  };
  const result = codeIssueSchema.safeParse(issue);
  assert.ok(result.success, 'Expected parse to succeed');
});

test('codeReviewSchema accepts valid review', () => {
  const result = codeReviewSchema.safeParse({
    summary: 'LGTM',
    issues: [],
    suggestions: [],
    approved: true,
  });
  assert.ok(result.success, 'Expected parse to succeed');
});

test('branchInfoSchema accepts valid branch info', () => {
  const info: BranchInfo = {
    current: 'main',
    all: ['main', 'dev'],
    isClean: true,
    hasUncommittedChanges: false,
  };
  const result = branchInfoSchema.safeParse(info);
  assert.ok(result.success, 'Expected parse to succeed');
});

test('ticketTypeSchema accepts valid ticket type', () => {
  const result = ticketTypeSchema.safeParse('bug');
  assert.ok(result.success, 'Expected parse to succeed');
});

test('errorCodeSchema accepts valid error code', () => {
  const result = errorCodeSchema.safeParse('AI_ERROR');
  assert.ok(result.success, 'Expected parse to succeed');
});

test('errorCodeSchema rejects unknown error code', () => {
  const result = errorCodeSchema.safeParse('UNKNOWN_CODE');
  assert.ok(!result.success, 'Expected parse to fail');
});

// --- 2. AppError hierarchy ---
console.log(chalk.bold('\n--- AppError hierarchy ---'));

test('AppError has correct name and code', () => {
  const err = new AppError('AI_ERROR', 'test');
  assert.equal(err.name, 'AppError');
  assert.equal(err.code, 'AI_ERROR');
  assert.ok(err instanceof Error);
});

test('AIError defaults to recoverable', () => {
  const err = new AIError('test');
  assert.equal(err.name, 'AIError');
  assert.equal(err.code, 'AI_ERROR');
  assert.equal(err.recoverable, true);
});

test('ValidationError defaults to non-recoverable', () => {
  const err = new ValidationError('test');
  assert.equal(err.name, 'ValidationError');
  assert.equal(err.code, 'VALIDATION_ERROR');
  assert.equal(err.recoverable, false);
});

test('GitError defaults to recoverable', () => {
  const err = new GitError('test');
  assert.equal(err.code, 'GIT_ERROR');
  assert.equal(err.recoverable, true);
});

test('JiraApiError defaults to recoverable', () => {
  const err = new JiraApiError('test');
  assert.equal(err.code, 'JIRA_API_ERROR');
  assert.equal(err.recoverable, true);
});

test('UserCancelledError has default message', () => {
  const err = new UserCancelledError();
  assert.equal(err.message, 'Operation cancelled by user');
  assert.equal(err.recoverable, false);
});

test('ConfigurationError is non-recoverable', () => {
  const err = new ConfigurationError('bad config');
  assert.equal(err.code, 'CONFIGURATION_ERROR');
  assert.equal(err.recoverable, false);
});

test('FileSystemError is recoverable', () => {
  const err = new FileSystemError('disk full');
  assert.equal(err.code, 'FILE_SYSTEM_ERROR');
  assert.equal(err.recoverable, true);
});

test('WorkflowParseError is non-recoverable', () => {
  const err = new WorkflowParseError('bad yaml');
  assert.equal(err.code, 'WORKFLOW_PARSE_ERROR');
  assert.equal(err.recoverable, false);
});

test('ExecutionError accepts recoverable flag', () => {
  const err = new ExecutionError('timeout', null, true);
  assert.equal(err.recoverable, true);
});

test('StateError defaults to recoverable', () => {
  const err = new StateError('corrupt');
  assert.equal(err.code, 'STATE_ERROR');
  assert.equal(err.recoverable, true);
});

test('All error subclasses extend AppError', () => {
  const errors = [
    new AIError('x'),
    new GitError('x'),
    new JiraApiError('x'),
    new ValidationError('x'),
    new WorkflowParseError('x'),
    new ExecutionError('x'),
    new StateError('x'),
    new UserCancelledError(),
    new ConfigurationError('x'),
    new FileSystemError('x'),
  ];
  for (const err of errors) {
    assert.ok(err instanceof AppError, `${err.name} should extend AppError`);
    assert.ok(err instanceof Error, `${err.name} should extend Error`);
  }
});

// --- 3. isAIErrorLike duck-typing ---
console.log(chalk.bold('\n--- isAIErrorLike duck-typing ---'));

test('isAIErrorLike detects AIError instance', () => {
  assert.ok(isAIErrorLike(new AIError('test')));
});

test('isAIErrorLike detects duck-typed object with code', () => {
  assert.ok(isAIErrorLike({ code: 'AI_ERROR', name: 'SomeError', message: 'x' }));
});

test('isAIErrorLike detects duck-typed object with name', () => {
  assert.ok(isAIErrorLike({ name: 'AIError', message: 'x' }));
});

test('isAIErrorLike rejects non-AI errors', () => {
  assert.ok(!isAIErrorLike(new GitError('test')));
  assert.ok(!isAIErrorLike(new Error('test')));
  assert.ok(!isAIErrorLike(null));
  assert.ok(!isAIErrorLike(undefined));
});

// --- 4. Facade backward compatibility ---
console.log(chalk.bold('\n--- Facade backward compatibility ---'));

test('Facade AIError is same as direct AIError', () => {
  assert.equal(FacadeAIError, AIError);
});

test('Facade isAIErrorLike is same as direct', () => {
  assert.equal(facadeIsAIErrorLike, isAIErrorLike);
});

test('ErrorCode enum values match ERROR_CODE const', () => {
  assert.equal(ErrorCode.AI_ERROR, ERROR_CODE.AI_ERROR);
  assert.equal(ErrorCode.GIT_ERROR, ERROR_CODE.GIT_ERROR);
  assert.equal(ErrorCode.VALIDATION_ERROR, ERROR_CODE.VALIDATION_ERROR);
  assert.equal(ErrorCode.JIRA_API_ERROR, ERROR_CODE.JIRA_API_ERROR);
  assert.equal(ErrorCode.CONFIGURATION_ERROR, ERROR_CODE.CONFIGURATION_ERROR);
  assert.equal(ErrorCode.FILE_SYSTEM_ERROR, ERROR_CODE.FILE_SYSTEM_ERROR);
  assert.equal(ErrorCode.STATE_ERROR, ERROR_CODE.STATE_ERROR);
  assert.equal(ErrorCode.USER_CANCELLED, ERROR_CODE.USER_CANCELLED);
  assert.equal(ErrorCode.WORKFLOW_PARSE_ERROR, ERROR_CODE.WORKFLOW_PARSE_ERROR);
  assert.equal(ErrorCode.EXECUTION_ERROR, ERROR_CODE.EXECUTION_ERROR);
  assert.equal(ErrorCode.APPROVAL_ERROR, ERROR_CODE.APPROVAL_ERROR);
});

// --- 5. ERROR_CODE const completeness ---
console.log(chalk.bold('\n--- ERROR_CODE completeness ---'));

test('ERROR_CODE has all 11 codes', () => {
  const codes = Object.keys(ERROR_CODE);
  assert.equal(codes.length, 11);
});

test('All ERROR_CODE values are valid per schema', () => {
  for (const value of Object.values(ERROR_CODE)) {
    const result = errorCodeSchema.safeParse(value);
    assert.ok(result.success, `${value} should be valid`);
  }
});

// --- Summary ---
console.log(chalk.bold(`\n${passed} passed, ${failed} failed`));
if (failed > 0) process.exit(1);
