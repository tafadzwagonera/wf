/**
 * Manual smoke test: review prose retry guard
 *
 * Run: nr test:manual -- test-review-prose-retry
 *
 * Verifies:
 *   1. requireReviewResponseContent passes prose (blank-only guard — demonstrates the gap).
 *   2. AiService.reviewCode retries when adapter returns prose, succeeds on second attempt.
 *   3. AiService.reviewCode throws descriptive AiProviderError when all attempts return prose.
 *   4. AiService.reviewCode does not retry prose when finishReason is non-recoverable.
 *
 * @returns Promise that resolves when the smoke test completes
 */
import chalk from 'chalk';
import { ConfigService } from '@nestjs/config';
import { AiService, requireReviewResponseContent } from '../../src/integrations/ai/ai.service';
import type { LlmAdapter } from '../../src/integrations/ai/llm-adapter.interface';
import type { LoggerService } from '../../src/shared/logger/logger.service';
import type { AIRequest, AIConversationRequest, AIResponse } from '../../src/shared/types/ai.types';
import { AiProviderError } from '../../src/shared/errors/app.error';

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

const VALID_REVIEW_JSON = JSON.stringify({
  summary: 'ok',
  issues: [],
  traceProvenance: 'unavailable',
  callStack: [],
  stateTransition: {},
  suggestions: [],
  approved: true,
});

const mockLogger: LoggerService = {
  debug: () => undefined,
  error: () => undefined,
  warn: () => undefined,
  log: () => undefined,
} as unknown as LoggerService;

const createConfigService = (): ConfigService =>
  ({
    get: (_key: string, defaultValue?: unknown) => defaultValue,
  }) as unknown as ConfigService;

const createSequenceAdapter = (responses: AIResponse[]): LlmAdapter => {
  let callCount = 0;
  return {
    execute: async (_request: AIRequest): Promise<AIResponse> => {
      const index = Math.min(callCount, responses.length - 1);
      callCount += 1;
      return responses[index];
    },
    executeWithHistory: async (_request: AIConversationRequest): Promise<AIResponse> => {
      return { content: 'ok' };
    },
    get callCount() {
      return callCount;
    },
  } as LlmAdapter & { callCount: number };
};

async function main(): Promise<void> {
  console.log(chalk.bold.cyan('\n🧪 Review prose retry guard smoke test\n'));

  console.log(chalk.bold('Test 1: requireReviewResponseContent passes prose (blank-only guard)'));
  {
    const proseResponse = {
      content: 'The code looks good overall. Nice work on the refactoring.',
      provider: 'openai',
      model: 'gpt-5.4',
      finishReason: 'stop',
    };

    let threwError = false;
    try {
      const result = requireReviewResponseContent(proseResponse);
      assert(
        'prose passes the blank-only guard and returns trimmed content',
        result === proseResponse.content.trim(),
        `got: "${result}"`
      );
    } catch {
      threwError = true;
    }

    assert(
      'requireReviewResponseContent does not throw on prose',
      !threwError,
      'unexpectedly threw an error on non-blank prose'
    );
  }

  console.log(chalk.bold('\nTest 2: reviewCode retries prose, succeeds on second attempt'));
  {
    const adapter = createSequenceAdapter([
      { content: 'The code looks good overall.', provider: 'openai', model: 'gpt-5.4', finishReason: 'stop' },
      { content: VALID_REVIEW_JSON, provider: 'openai', model: 'gpt-5.4', finishReason: 'stop' },
    ]);
    const service = new AiService(mockLogger, adapter, createConfigService());

    const review = await service.reviewCode('diff --git a/f b/f\n+line', ['guideline']);

    assert(
      'adapter called twice (retry fired)',
      (adapter as LlmAdapter & { callCount: number }).callCount === 2,
      `got: ${(adapter as LlmAdapter & { callCount: number }).callCount}`
    );
    assert(
      'review parsed from second response',
      review.summary === 'ok',
      `got: ${review.summary}`
    );
  }

  console.log(chalk.bold('\nTest 3: reviewCode throws descriptive AiProviderError when all attempts return prose'));
  {
    const adapter = createSequenceAdapter([
      { content: 'The code looks good overall.', provider: 'openai', model: 'gpt-5.4', finishReason: 'stop' },
      { content: 'I recommend improving the error handling.', provider: 'openai', model: 'gpt-5.4', finishReason: 'stop' },
    ]);
    const service = new AiService(mockLogger, adapter, createConfigService());

    let caughtError: unknown;
    try {
      await service.reviewCode('diff', ['guideline']);
    } catch (error) {
      caughtError = error;
    }

    assert(
      'threw an AiProviderError',
      caughtError instanceof AiProviderError,
      `got: ${caughtError instanceof Error ? caughtError.constructor.name : typeof caughtError}`
    );

    const aiError = caughtError as AiProviderError;
    assert(
      'error message mentions prose response without JSON',
      aiError.message.includes('prose review response without JSON'),
      `got: "${aiError.message}"`
    );
    assert(
      'adapter called twice before throwing',
      (adapter as LlmAdapter & { callCount: number }).callCount === 2,
      `got: ${(adapter as LlmAdapter & { callCount: number }).callCount}`
    );
  }

  console.log(chalk.bold('\nTest 4: reviewCode does not retry prose when finishReason is non-recoverable'));
  {
    const adapter = createSequenceAdapter([
      { content: 'I cannot review this code.', provider: 'openai', model: 'gpt-5.4', finishReason: 'content_filter' },
      { content: VALID_REVIEW_JSON, provider: 'openai', model: 'gpt-5.4', finishReason: 'stop' },
    ]);
    const service = new AiService(mockLogger, adapter, createConfigService());

    let caughtError: unknown;
    try {
      await service.reviewCode('diff', ['guideline']);
    } catch (error) {
      caughtError = error;
    }

    assert(
      'threw an AiProviderError immediately',
      caughtError instanceof AiProviderError,
      `got: ${caughtError instanceof Error ? caughtError.constructor.name : typeof caughtError}`
    );
    assert(
      'adapter called only once (no retry on content_filter)',
      (adapter as LlmAdapter & { callCount: number }).callCount === 1,
      `got: ${(adapter as LlmAdapter & { callCount: number }).callCount}`
    );
  }

  console.log(chalk.bold('\nSummary'));
  console.log(`  Passed: ${passed}`);
  console.log(`  Failed: ${failed}`);

  if (failed > 0) {
    process.exit(1);
  }
}

void main();
