/**
 * Manual smoke test: model-fallback retry path also denormalizes OpenAI structured-output responses
 *
 * Run: nr test:manual openai-structured-output-fallback-retry.smoke.ts
 *
 * Verifies:
 *   1. The fallback retry response has normalization-injected nulls stripped.
 *   2. The llm-adapter log records ai.model.fallback before ai.structured-output.denormalize.
 *   3. A fallback retry returning an anthropic response emits no denormalize log entry.
 */
import chalk from 'chalk';
import { AiService } from '../../src/integrations/ai/ai.service';
import { LoggerService } from '../../src/shared/logger/logger.service';
import type { LlmAdapter } from '../../src/integrations/ai/llm-adapter.interface';
import type { ConfigService } from '@nestjs/config';
import * as logFileWriter from '../../src/shared/logger/log-file-writer';
import { AiProviderError } from '../../src/shared/errors/app.error';
import { stepAssessmentResponseJsonSchema } from '../../src/shared/schemas/step-verification.schema';
import { createReporter, summarise } from './support/reporter';

const { counts, pass, fail } = createReporter();

const structuredOutput = { name: 'plan_step_assessment', schema: stepAssessmentResponseJsonSchema };
const payloadWithNull = { statuses: [{ index: 0, status: 'done', missing: null }] };

function buildConfigService(provider: string, model: string): ConfigService {
  return {
    get: (key: string, defaultValue?: unknown) => {
      const values: Record<string, unknown> = {
        'logging.level': 'info',
        'ai.provider': provider,
        'ai.model': model,
        'ai.providers': [{ provider, model }],
      };
      return key in values ? values[key] : defaultValue;
    },
  } as unknown as ConfigService;
}

function buildFailFirstAdapter(provider: string, model: string): LlmAdapter {
  let callCount = 0;
  return {
    execute: async () => {
      if (++callCount === 1) throw new AiProviderError('model not found', { status: 404 }, true, 'api');
      return {
        content: JSON.stringify(payloadWithNull), provider, model,
        usage: { inputTokens: 10, outputTokens: 5 },
      };
    },
    executeWithHistory: async () => ({ content: '', provider, model }),
  };
}

function buildFallbackService(provider: string, model: string): AiService {
  const configService = buildConfigService(provider, model);
  return new AiService(new LoggerService(configService), buildFailFirstAdapter(provider, model), configService);
}

function captureLogFile(): { fileLines: string[]; restore: () => void } {
  const fileLines: string[] = [];
  const originalAppend = logFileWriter.appendToLogFile;
  (logFileWriter as Record<string, unknown>).appendToLogFile = (level: string, message: string, context?: string) =>
    fileLines.push(`[${level}] [${context ?? ''}] ${message}`);
  const restore = (): void => {
    (logFileWriter as Record<string, unknown>).appendToLogFile = originalAppend;
  };
  return { fileLines, restore };
}

function checkFallbackNullsStripped(content: string): void {
  const { statuses } = JSON.parse(content) as { statuses: Array<Record<string, unknown>> };
  if ('missing' in statuses[0]) {
    fail('fallback retry: null not stripped from retry response', JSON.stringify(statuses[0]));
  } else {
    pass('fallback retry: null stripped from fallback retry openai response');
  }
}

function checkFallbackLogOrder(fileLines: string[]): void {
  const fallbackIdx = fileLines.findIndex(l => l.includes('ai.model.fallback'));
  const denormalizeIdx = fileLines.findIndex(l => l.includes('ai.structured-output.denormalize'));
  if (fallbackIdx !== -1 && denormalizeIdx !== -1 && fallbackIdx < denormalizeIdx) {
    pass('log order: ai.model.fallback appears before ai.structured-output.denormalize');
  } else {
    fail('log order: expected fallback then denormalize entries not found in order', fileLines.join(' | ') || '(none)');
  }
}

function checkNoDenormalizeLog(fileLines: string[], label: string): void {
  const hasLog = fileLines.some(l => l.includes('ai.structured-output.denormalize'));
  if (hasLog) {
    fail(`${label}: unexpected denormalize log entry emitted`);
  } else {
    pass(`${label}: no denormalize log entry emitted`);
  }
}

async function checkFallbackDenormalized(): Promise<void> {
  const service = buildFallbackService('openai', 'gpt-5.4');
  const { fileLines, restore } = captureLogFile();
  try {
    const response = await service.execute({
      prompt: 'assess', stage: 'implement',
      provider: 'openai', model: 'gpt-5.4-bad', structuredOutput: structuredOutput,
    });
    checkFallbackNullsStripped(response.content);
    checkFallbackLogOrder(fileLines);
  } finally {
    restore();
  }
}

async function checkFallbackAnthropicNoLog(): Promise<void> {
  const service = buildFallbackService('anthropic', 'claude-sonnet-4-6');
  const { fileLines, restore } = captureLogFile();
  try {
    await service.execute({
      prompt: 'assess', provider: 'anthropic',
      model: 'claude-bad', structuredOutput: structuredOutput,
    });
    checkNoDenormalizeLog(fileLines, 'fallback anthropic');
  } finally {
    restore();
  }
}

async function main(): Promise<void> {
  console.log(chalk.bold('\nOpenAI structured-output fallback retry smoke test\n'));
  await checkFallbackDenormalized();
  await checkFallbackAnthropicNoLog();
  summarise(counts);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
