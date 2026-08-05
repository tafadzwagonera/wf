/**
 * Manual smoke test: reviewViaAgent falls back to validateReviewJson on parse AIError
 *
 * Run: nr test:manual -- test-review-agent-fallback-validation
 *
 * Verifies:
 *   1. Parse AIError with details.response triggers validateReviewJson fallback
 *   2. Recovered review has executionMode matching backend config
 *   3. Parse AIError without details.response re-throws
 *   4. Non-parse AIError re-throws unmodified
 *   5. Backend 'cli' yields executionMode 'cli'
 *
 * @returns Promise that resolves when the smoke test completes
 */
import chalk from 'chalk';
import { ConfigService } from '@nestjs/config';
import { AiService } from '../../src/integrations/ai/ai.service';
import { ReviewStageService } from '../../src/workflows/stages/review-stage.service';
import { StageAgentService } from '../../src/integrations/ai/stage-agent.service';
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

const validReviewPayload = JSON.stringify({
  summary: 'recovered', issues: [], traceProvenance: 'unavailable',
  callStack: [], stateTransition: {}, suggestions: [], approved: true,
});

const mockLogger: LoggerService = {
  debug: () => undefined, error: () => undefined,
  warn: () => undefined, log: () => undefined,
} as unknown as LoggerService;

const createConfigService = (overrides: Record<string, unknown> = {}): ConfigService =>
  ({
    get: (key: string, defaultValue?: unknown) => {
      if (key in overrides) return overrides[key];
      return defaultValue;
    },
  }) as unknown as ConfigService;

const createNoopAdapter = (): LlmAdapter => ({
  execute: async (_request: AIRequest): Promise<AIResponse> =>
    ({ content: validReviewPayload, provider: 'openai', model: 'gpt-5.4', finishReason: 'stop' }),
  executeWithHistory: async (_request: AIConversationRequest): Promise<AIResponse> =>
    ({ content: 'ok' }),
}) as LlmAdapter;

const createStageAgentStub = (error: Error): StageAgentService => ({
  isEnabledForStage: () => true,
  reviewCode: async () => { throw error; },
}) as unknown as StageAgentService;

async function main(): Promise<void> {
  console.log(chalk.bold.cyan('\nReview agent fallback validation smoke test\n'));

  console.log(chalk.bold('Test 1: parse AIError with response triggers fallback'));
  {
    const parseError = new AIError('parse fail', { response: validReviewPayload }, true, 'parse');
    const configService = createConfigService({ 'stages.review.backend': 'agent' });
    const aiService = new AiService(mockLogger, createNoopAdapter(), configService);
    const stageAgent = createStageAgentStub(parseError);
    const service = new ReviewStageService(aiService, configService, stageAgent);

    const review = await service.reviewDiff(MINIMAL_DIFF, { context: 'test' });
    assert('review recovered', review.summary === 'recovered', `got: ${review.summary}`);
    assert('executionMode is agent', review.executionMode === 'agent', `got: ${review.executionMode}`);
  }

  console.log(chalk.bold('\nTest 2: parse AIError without details.response re-throws'));
  {
    const parseError = new AIError('parse fail', {}, true, 'parse');
    const configService = createConfigService({ 'stages.review.backend': 'agent' });
    const aiService = new AiService(mockLogger, createNoopAdapter(), configService);
    const stageAgent = createStageAgentStub(parseError);
    const service = new ReviewStageService(aiService, configService, stageAgent);

    let caughtError: unknown;
    try {
      await service.reviewDiff(MINIMAL_DIFF, { context: 'test' });
    } catch (error) {
      caughtError = error;
    }
    assert('error re-thrown', caughtError === parseError, `got: ${String(caughtError)}`);
  }

  console.log(chalk.bold('\nTest 3: non-parse AIError re-throws'));
  {
    const authError = new AIError('auth fail', { response: validReviewPayload }, true, 'auth');
    const configService = createConfigService({ 'stages.review.backend': 'agent' });
    const aiService = new AiService(mockLogger, createNoopAdapter(), configService);
    const stageAgent = createStageAgentStub(authError);
    const service = new ReviewStageService(aiService, configService, stageAgent);

    let caughtError: unknown;
    try {
      await service.reviewDiff(MINIMAL_DIFF, { context: 'test' });
    } catch (error) {
      caughtError = error;
    }
    assert('auth error re-thrown', caughtError === authError, `got: ${String(caughtError)}`);
  }

  console.log(chalk.bold('\nTest 4: backend cli yields executionMode cli'));
  {
    const parseError = new AIError('parse fail', { response: validReviewPayload }, true, 'parse');
    const configService = createConfigService({ 'stages.review.backend': 'cli' });
    const aiService = new AiService(mockLogger, createNoopAdapter(), configService);
    const stageAgent = createStageAgentStub(parseError);
    const service = new ReviewStageService(aiService, configService, stageAgent);

    const review = await service.reviewDiff(MINIMAL_DIFF, { context: 'test' });
    assert('executionMode is cli', review.executionMode === 'cli', `got: ${review.executionMode}`);
  }

  console.log(chalk.bold('\nSummary'));
  console.log(`  Passed: ${passed}`);
  console.log(`  Failed: ${failed}`);

  if (failed > 0) process.exit(1);
}

void main();
