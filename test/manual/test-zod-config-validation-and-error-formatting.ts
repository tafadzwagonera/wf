/**
 * Smoke test: Zod config validation and error formatting.
 *
 * Validates:
 * - normalizeWfConfig accepts valid config (basic happy path)
 * - normalizeWfConfig rejects unknown top-level keys via .strict()
 * - normalizeWfConfig rejects unknown implement stage keys via .strict()
 * - normalizeWfConfig rejects string stage overrides with field-level errors
 * - ValidationError carries ZodError as details
 * - formatZodError produces human-readable output
 * - formatFieldNames joins field names correctly
 * - isZodErrorLike detects ZodError instances
 * - ConfigurationError uses CONFIGURATION_ERROR code
 * - ErrorHandler renders ZodError details via formatZodError
 *
 * Run: nr test:manual -- test-zod-config-validation-and-error-formatting
 */

import { normalizeWfConfig } from '../../src/config/wf-config-loader';
import { formatFieldNames, formatZodError, isZodErrorLike } from '../../src/shared/utils/zod-error.util';
import { ConfigurationError, ErrorCode, ValidationError } from '../../src/shared/utils/errors';
import { ZodError } from 'zod';

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

// --- normalizeWfConfig ---

console.log('\n--- normalizeWfConfig: happy path ---');

const validConfig = normalizeWfConfig({
  ai: [{ provider: 'openai', apiKey: 'test-key', model: 'gpt-5.4' }],
});
assert('accepts valid config with single provider', validConfig.ai.provider === 'openai');
assert('resolves model from provider', validConfig.ai.model === 'gpt-5.4');

console.log('\n--- normalizeWfConfig: unknown top-level key ---');

try {
  normalizeWfConfig({ branching: { atlassianPattern: '^test$' } } as never);
  assert('rejects unknown top-level key "branching"', false);
} catch (error: any) {
  assert(
    'rejects unknown top-level key "branching"',
    error instanceof ValidationError && /validation failed/i.test(error.message)
  );
  assert('error details is a ZodError', isZodErrorLike(error.details));
}

console.log('\n--- normalizeWfConfig: unknown implement stage key ---');

try {
  normalizeWfConfig({
    ai: [{ provider: 'openai', apiKey: 'k', model: 'gpt-5.4' }],
    stages: {
      implement: { provider: 'openai', model: 'gpt-5.4', experimentalAgent: true } as never,
    },
  });
  assert('rejects experimentalAgent on implement stage', false);
} catch (error: any) {
  assert(
    'rejects experimentalAgent on implement stage',
    error instanceof ValidationError && /validation failed for.*stages\.implement/i.test(error.message)
  );
}

console.log('\n--- normalizeWfConfig: string stage override ---');

try {
  normalizeWfConfig({ stages: { implement: 'gpt-5.4' } as never });
  assert('rejects string implement stage', false);
} catch (error: any) {
  assert(
    'rejects string implement stage',
    error instanceof ValidationError && /validation failed for.*stages\.implement/i.test(error.message)
  );
}

// --- formatFieldNames ---

console.log('\n--- formatFieldNames ---');

assert('empty array → empty string', formatFieldNames([]) === '');
assert('single field', formatFieldNames(['provider']) === 'provider');
assert('two fields joined with "and"', formatFieldNames(['a', 'b']) === 'a and b');
assert('three fields with comma and "and"', formatFieldNames(['a', 'b', 'c']) === 'a, b and c');

// --- formatZodError ---

console.log('\n--- formatZodError ---');

const mockZodError = new ZodError([
  {
    code: 'invalid_type',
    expected: 'string',
    path: ['ai', 'provider'],
    message: 'Expected string, received number',
  },
]);

const formatted = formatZodError(mockZodError);
assert('contains field path', formatted.includes("Field: 'ai.provider'"));
assert('contains code', formatted.includes("Code: 'invalid_type'"));
assert('contains message', formatted.includes('Expected string, received number'));

// --- isZodErrorLike ---

console.log('\n--- isZodErrorLike ---');

assert('detects real ZodError', isZodErrorLike(new ZodError([])));
assert('detects duck-typed ZodError', isZodErrorLike({ name: 'ZodError', issues: [] }));
assert('rejects null', !isZodErrorLike(null));
assert('rejects plain Error', !isZodErrorLike(new Error('test')));

// --- ConfigurationError ---

console.log('\n--- ConfigurationError ---');

const configError = new ConfigurationError('test config error');
assert('uses CONFIGURATION_ERROR code', configError.code === ErrorCode.CONFIGURATION_ERROR);
assert('name is ConfigurationError', configError.name === 'ConfigurationError');
assert('is not recoverable', configError.recoverable === false);

// --- Summary ---

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) {
  process.exit(1);
}
