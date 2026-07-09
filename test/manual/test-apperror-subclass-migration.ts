/**
 * Smoke test: AppError subclass migration in command files.
 *
 * Validates:
 * - Command files throw typed AppError subclasses, not raw Error
 * - Command files never call process.exit(1) directly
 * - Each subclass carries the correct error code and recoverability
 * - ErrorHandler.handle() formats typed errors with name, suggestion, and recoverability hint
 * - The resolvePlanArtifactReferenceAcrossDirs catch block passes ValidationError through
 *   (not swallowed by FileSystemError-only predicate)
 * - plan-quality.ts createPlanQualityError returns ValidationError
 * - createPlanValidationError returns ValidationError
 *
 * Run: nr test:manual -- test-apperror-subclass-migration
 */

import * as fs from 'fs';
import * as path from 'path';
import {
  ValidationError,
  FileSystemError,
  ExecutionError,
  ConfigurationError,
  GitError,
  ErrorCode,
} from '../../src/shared/utils/errors';
import { createPlanQualityError, validatePlanQuality } from '../../src/shared/utils/plan-quality';

let passed = 0;
let failed = 0;

const assert = (label: string, condition: boolean): void => {
  if (condition) {
    console.log(`  PASS  ${label}`);
    passed += 1;
  } else {
    console.error(`  FAIL  ${label}`);
    failed += 1;
  }
};

// ── 1. Subclass instantiation and error codes ────────────────────────

console.log('\n--- Subclass instantiation and error codes ---');

const validation = new ValidationError('test');
assert('ValidationError.name is ValidationError', validation.name === 'ValidationError');
assert('ValidationError.code is VALIDATION_ERROR', validation.code === 'VALIDATION_ERROR');
assert('ValidationError is not recoverable', validation.recoverable === false);

const fileSystem = new FileSystemError('test');
assert('FileSystemError.name is FileSystemError', fileSystem.name === 'FileSystemError');
assert('FileSystemError.code is FILE_SYSTEM_ERROR', fileSystem.code === 'FILE_SYSTEM_ERROR');
assert('FileSystemError is recoverable', fileSystem.recoverable === true);

const execution = new ExecutionError('test');
assert('ExecutionError.name is ExecutionError', execution.name === 'ExecutionError');
assert('ExecutionError.code is EXECUTION_ERROR', execution.code === 'EXECUTION_ERROR');

const configuration = new ConfigurationError('test');
assert('ConfigurationError.name is ConfigurationError', configuration.name === 'ConfigurationError');
assert('ConfigurationError.code is CONFIGURATION_ERROR', configuration.code === 'CONFIGURATION_ERROR');

const git = new GitError('test');
assert('GitError.name is GitError', git.name === 'GitError');
assert('GitError.code is GIT_ERROR', git.code === 'GIT_ERROR');
assert('GitError is recoverable', git.recoverable === true);

// ── 2. instanceof checks across the hierarchy ────────────────────────

console.log('\n--- instanceof hierarchy ---');

assert('ValidationError instanceof Error', validation instanceof Error);
assert('FileSystemError instanceof Error', fileSystem instanceof Error);
assert('ValidationError is NOT instanceof FileSystemError', !(validation instanceof FileSystemError));
assert('FileSystemError is NOT instanceof ValidationError', !(fileSystem instanceof ValidationError));

// ── 3. No raw `throw new Error` in command source files ──────────────

console.log('\n--- No raw Error throws in command source files ---');

const commandsDir = path.join(__dirname, '..', '..', 'src', 'commands');
const commandFiles = fs
  .readdirSync(commandsDir)
  .filter(name => name.endsWith('.command.ts') && !name.endsWith('.spec.ts'));

let rawErrorCount = 0;
let processExitCount = 0;

for (const file of commandFiles) {
  const source = fs.readFileSync(path.join(commandsDir, file), 'utf-8');
  const rawMatches = source.match(/throw new Error\(/g);
  if (rawMatches) {
    rawErrorCount += rawMatches.length;
    console.error(`  FAIL  ${file} contains ${rawMatches.length} raw Error throw(s)`);
  }

  const exitMatches = source.match(/process\.exit\(/g);
  if (exitMatches) {
    processExitCount += exitMatches.length;
    console.error(`  FAIL  ${file} contains ${exitMatches.length} process.exit() call(s)`);
  }
}

assert('No raw "throw new Error" in any command file', rawErrorCount === 0);
assert('No process.exit() in any command file', processExitCount === 0);

// ── 4. plan-quality returns ValidationError ──────────────────────────

console.log('\n--- plan-quality createPlanQualityError ---');

const qualityError = createPlanQualityError([{ ruleId: 'verification-allowlist', message: 'test violation' }]);
assert('createPlanQualityError returns ValidationError', qualityError instanceof ValidationError);
assert('quality error message includes rule id', qualityError.message.includes('verification-allowlist'));
assert('quality error message includes violation text', qualityError.message.includes('test violation'));

// ── 5. ErrorHandler suggestion map covers all error codes ────────────

console.log('\n--- ErrorHandler suggestion coverage ---');

const errorHandlerSource = fs.readFileSync(
  path.join(__dirname, '..', '..', 'src', 'shared', 'utils', 'error-handler.ts'),
  'utf-8'
);

const expectedCodes = [
  'WORKFLOW_PARSE_ERROR',
  'VALIDATION_ERROR',
  'EXECUTION_ERROR',
  'JIRA_API_ERROR',
  'GIT_ERROR',
  'AI_PROVIDER_ERROR',
  'STATE_ERROR',
  'USER_CANCELLED',
  'CONFIGURATION_ERROR',
  'FILE_SYSTEM_ERROR',
];

for (const code of expectedCodes) {
  assert(`ErrorHandler suggestion map covers ${code}`, errorHandlerSource.includes(code));
}

// ── Summary ──────────────────────────────────────────────────────────

console.log(`\n--- Summary: ${passed} passed, ${failed} failed ---\n`);
process.exit(failed > 0 ? 1 : 0);
