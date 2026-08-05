/**
 * Manual smoke test: validateReviewJson retries Zod failures via LLM self-correction
 *
 * Run: nr test:manual -- test-review-validation-retry
 *
 * Verifies:
 *   1. Valid JSON passes on first attempt without any adapter calls
 *   2. JSON missing a required top-level field throws AIError immediately
 *   3. JSON with a Zod violation triggers one correction call and returns the corrected review
 *   4. Stalled correction (same error count) bails after the first attempt
 *   5. Exhausted retries throw AIError with "could not be corrected"
 *   6. Null issue fields coerced to undefined without triggering correction
 *
 * @returns Promise that resolves when the smoke test completes
 */
import chalk from 'chalk';
import { ConfigService } from '@nestjs/config';
import { AiService } from '../../src/integrations/ai/ai.service';
import type { LlmAdapter } from '../../src/integrations/ai/llm-adapter.interface';
import type { LoggerService } from '../../src/shared/logger/logger.service';
import type { AIRequest, AIConversationRequest, AIResponse } from '../../src/shared/types/ai.types';
import { AIError } from '../../src/shared/errors/app.error';

let passed = 0;
let failed = 0;

const pass = (message: string): void => {
  console.log(chalk.green(`  ✓ ${message}`));
  passed += 1;
};

const fail = (message: string, detail?: string): void => {
  console.error(chalk.red(`  ✗ ${message}${detail ? `\n    → ${detail}` : ''}`));
  failed += 1;
};

const assert = (message: string, condition: boolean, detail?: string): void => {
  if (condition) {
    pass(message);
    return;
  }
  fail(message, detail);
};

const MINIMAL_DIFF = 'diff --git a/f b/f\n+line';

const validReviewJson = (overrides?: Record<string, unknown>): string =>
  JSON.stringify({
    summary: 'ok',
    issues: [],
    traceProvenance: 'unavailable',
    callStack: [],
    stateTransition: {},
    suggestions: [],
    approved: true,
    ...overrides,
  });

const mockLogger: LoggerService = {
  debug: () => undefined,
  error: () => undefined,
  warn: () => undefined,
  log: () => undefined,
} as unknown as LoggerService;

const createConfigService = (): ConfigService =>
  ({ get: (_key: string, defaultValue?: unknown) => defaultValue }) as unknown as ConfigService;

const createSequenceAdapter = (responses: AIResponse[]): LlmAdapter & { callCount: number } => {
  let callCount = 0;
  return {
    execute: async (_request: AIRequest): Promise<AIResponse> => {
      const index = Math.min(callCount, responses.length - 1);
      callCount += 1;
      return responses[index];
    },
    executeWithHistory: async (_request: AIConversationRequest): Promise<AIResponse> =>
      ({ content: 'ok' }),
    get callCount() {
      return callCount;
    },
  } as LlmAdapter & { callCount: number };
};

async function main(): Promise<void> {
  console.log(chalk.bold.cyan('\nReview validation retry smoke test\n'));

  console.log(chalk.bold('Test 1: valid JSON passes without adapter calls'));
  {
    const adapter = createSequenceAdapter([]);
    const service = new AiService(mockLogger, adapter, createConfigService());
    const review = await service.validateReviewJson(validReviewJson(), MINIMAL_DIFF);
    assert('review parsed successfully', review.summary === 'ok', `got: ${review.summary}`);
    assert('adapter never called', adapter.callCount === 0, `got: ${adapter.callCount}`);
  }

  console.log(chalk.bold('\nTest 2: missing top-level field throws AIError immediately'));
  {
    const noApproved = JSON.stringify({ summary: 'ok', issues: [], suggestions: [] });
    const adapter = createSequenceAdapter([]);
    const service = new AiService(mockLogger, adapter, createConfigService());
    let caughtError: unknown;
    try {
      await service.validateReviewJson(noApproved, MINIMAL_DIFF);
    } catch (error) {
      caughtError = error;
    }
    assert('threw AIError', caughtError instanceof AIError, `got: ${String(caughtError)}`);
    assert(
      'message mentions required top-level fields',
      (caughtError as AIError).message.includes('lacks required top-level fields'),
      `got: "${(caughtError as AIError).message}"`
    );
    assert('adapter never called', adapter.callCount === 0, `got: ${adapter.callCount}`);
  }

  console.log(chalk.bold('\nTest 3: Zod violation triggers one correction call'));
  {
    const badSeverity = JSON.stringify({
      summary: 'ok', issues: [{ severity: 'critical', message: 'bad' }],
      traceProvenance: 'unavailable', callStack: [], stateTransition: {},
      suggestions: [], approved: true,
    });
    const correctedResponse: AIResponse = {
      content: validReviewJson({ issues: [{ severity: 'warning', message: 'bad' }] }),
      provider: 'openai', model: 'gpt-5.4', finishReason: 'stop',
    };
    const adapter = createSequenceAdapter([correctedResponse]);
    const service = new AiService(mockLogger, adapter, createConfigService());
    const review = await service.validateReviewJson(badSeverity, MINIMAL_DIFF);
    assert('review parsed after correction', review.summary === 'ok', `got: ${review.summary}`);
    assert('adapter called once', adapter.callCount === 1, `got: ${adapter.callCount}`);
  }

  console.log(chalk.bold('\nTest 4: stalled correction bails early'));
  {
    const badSeverity = JSON.stringify({
      summary: 'ok', issues: [{ severity: 'critical', message: 'bad' }],
      traceProvenance: 'unavailable', callStack: [], stateTransition: {},
      suggestions: [], approved: true,
    });
    const stillBad: AIResponse = {
      content: JSON.stringify({
        summary: 'ok', issues: [{ severity: 'nope', message: 'still bad' }],
        traceProvenance: 'unavailable', callStack: [], stateTransition: {},
        suggestions: [], approved: true,
      }),
      provider: 'openai', model: 'gpt-5.4', finishReason: 'stop',
    };
    const adapter = createSequenceAdapter([stillBad, stillBad]);
    const service = new AiService(mockLogger, adapter, createConfigService());
    let caughtError: unknown;
    try {
      await service.validateReviewJson(badSeverity, MINIMAL_DIFF);
    } catch (error) {
      caughtError = error;
    }
    assert('threw AIError', caughtError instanceof AIError, `got: ${String(caughtError)}`);
    assert(
      'adapter called once (stall detected, no second retry)',
      adapter.callCount === 1,
      `got: ${adapter.callCount}`
    );
  }

  console.log(chalk.bold('\nTest 5: exhausted retries throw AIError'));
  {
    const badSeverity = JSON.stringify({
      summary: 'ok', issues: [{ severity: 'critical', message: 'bad' }],
      traceProvenance: 'unavailable', callStack: [], stateTransition: {},
      suggestions: [], approved: true,
    });
    const slightlyBetter: AIResponse = {
      content: JSON.stringify({
        summary: 'ok', issues: [{ severity: 'bad1', message: 'a' }, { severity: 'bad2', message: 'b' }],
        traceProvenance: 'unavailable', callStack: [], stateTransition: {},
        suggestions: [], approved: true,
      }),
      provider: 'openai', model: 'gpt-5.4', finishReason: 'stop',
    };
    const evenMore: AIResponse = {
      content: JSON.stringify({
        summary: 'ok', issues: [{ severity: 'x', message: 'a' }, { severity: 'y', message: 'b' }, { severity: 'z', message: 'c' }],
        traceProvenance: 'unavailable', callStack: [], stateTransition: {},
        suggestions: [], approved: true,
      }),
      provider: 'openai', model: 'gpt-5.4', finishReason: 'stop',
    };
    const adapter = createSequenceAdapter([slightlyBetter, evenMore]);
    const service = new AiService(mockLogger, adapter, createConfigService());
    let caughtError: unknown;
    try {
      await service.validateReviewJson(badSeverity, MINIMAL_DIFF);
    } catch (error) {
      caughtError = error;
    }
    assert('threw AIError', caughtError instanceof AIError, `got: ${String(caughtError)}`);
    assert(
      'message mentions could not be corrected',
      (caughtError as AIError).message.includes('could not be corrected'),
      `got: "${(caughtError as AIError).message}"`
    );
  }

  console.log(chalk.bold('\nTest 6: null issue fields coerced without triggering correction'));
  {
    const withNulls = JSON.stringify({
      summary: 'ok',
      issues: [{ severity: 'info', message: 'test', file: null, line: null, endLine: null, suggestion: null }],
      traceProvenance: 'unavailable', callStack: [], stateTransition: {},
      suggestions: [], approved: true,
    });
    const adapter = createSequenceAdapter([]);
    const service = new AiService(mockLogger, adapter, createConfigService());
    const review = await service.validateReviewJson(withNulls, MINIMAL_DIFF);
    assert('review parsed successfully', review.summary === 'ok', `got: ${review.summary}`);
    assert('adapter never called (no correction needed)', adapter.callCount === 0, `got: ${adapter.callCount}`);
    const issue = review.issues[0];
    assert('file coerced to undefined', issue.file === undefined, `got: ${JSON.stringify(issue.file)}`);
    assert('line coerced to undefined', issue.line === undefined, `got: ${JSON.stringify(issue.line)}`);
    assert('endLine coerced to undefined', issue.endLine === undefined, `got: ${JSON.stringify(issue.endLine)}`);
    assert('suggestion coerced to undefined', issue.suggestion === undefined, `got: ${JSON.stringify(issue.suggestion)}`);
  }

  console.log(chalk.bold('\nSummary'));
  console.log(`  Passed: ${passed}`);
  console.log(`  Failed: ${failed}`);

  if (failed > 0) process.exit(1);
}

void main();
