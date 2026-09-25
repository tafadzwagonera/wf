/**
 * Manual smoke test: AiService strips OpenAI-injected nulls from structured-output responses
 *
 * Run: nr test:manual openai-structured-output-denormalization.smoke.ts
 *
 * Verifies:
 *   1. Adapter response with provider=openai has normalization-injected nulls stripped.
 *   2. llm-adapter log emits ai.structured-output.denormalize with stage and stripped paths.
 *   3. Anthropic response passes through byte-identical (no strip, no re-stringify).
 *   4. Fenced JSON response (```json...```) is still denormalized via parseJsonResponse.
 *   5. Non-JSON content passes through unchanged without throwing.
 *   6. Response without structuredOutput in request passes through byte-identical.
 */
import chalk from 'chalk';
import { AiService } from '../../src/integrations/ai/ai.service';
import { LoggerService } from '../../src/shared/logger/logger.service';
import type { LlmAdapter } from '../../src/integrations/ai/llm-adapter.interface';
import type { ConfigService } from '@nestjs/config';
import * as logFileWriter from '../../src/shared/logger/log-file-writer';
import { stepAssessmentResponseJsonSchema } from '../../src/shared/schemas/step-verification.schema';
import { createReporter, summarise } from './support/reporter';

const { counts, pass, fail } = createReporter();

const STRUCTURED_OUTPUT = { name: 'plan_step_assessment', schema: stepAssessmentResponseJsonSchema };
const PAYLOAD_WITH_NULL = { statuses: [{ index: 0, status: 'done', missing: null }] };

function buildConfigService(): ConfigService {
  return {
    get: (key: string, defaultValue?: unknown) => {
      const values: Record<string, unknown> = { 'logging.level': 'info', 'ai.provider': 'openai', 'ai.model': 'gpt-5.4' };
      return key in values ? values[key] : defaultValue;
    },
  } as unknown as ConfigService;
}

function buildAdapter(content: string, provider: string, model: string): LlmAdapter {
  return {
    execute: async () => ({ content, provider, model, usage: { inputTokens: 10, outputTokens: 5 } }),
    executeWithHistory: async () => ({ content, provider, model, usage: { inputTokens: 10, outputTokens: 5 } }),
  };
}

function buildService(content: string, provider: string, model: string): { service: AiService; fileLines: string[] } {
  const configService = buildConfigService();
  const adapter = buildAdapter(content, provider, model);
  const service = new AiService(new LoggerService(configService), adapter, configService);
  const fileLines: string[] = [];
  (logFileWriter as Record<string, unknown>).appendToLogFile = (level: string, message: string, context?: string) =>
    fileLines.push(`[${level}] [${context ?? ''}] ${message}`);
  return { service, fileLines };
}

function checkDenormalizeLogEntry(fileLines: string[]): void {
  const logLine = fileLines.find(l => l.includes('ai.structured-output.denormalize'));
  if (logLine?.includes('stage=implement') && logLine.includes('stripped=statuses[0].missing')) {
    pass('log entry: ai.structured-output.denormalize with stage=implement and correct path');
  } else {
    fail('log entry: expected ai.structured-output.denormalize not found', fileLines.join(' | ') || '(none)');
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

function checkNonJsonResult(threw: boolean, content: string): void {
  if (threw) {
    fail('non-json passthrough: threw instead of returning original content');
  } else if (content === 'not json at all') {
    pass('non-json passthrough: content returned unchanged without throwing');
  } else {
    fail('non-json passthrough: content was unexpectedly modified', content);
  }
}

async function checkNullsStripped(originalAppend: typeof logFileWriter.appendToLogFile): Promise<void> {
  const { service, fileLines } = buildService(JSON.stringify(PAYLOAD_WITH_NULL), 'openai', 'gpt-5.4');
  const response = await service.execute({
    prompt: 'assess', stage: 'implement', provider: 'openai', model: 'gpt-5.4', structuredOutput: STRUCTURED_OUTPUT,
  });
  (logFileWriter as Record<string, unknown>).appendToLogFile = originalAppend;
  const { statuses } = JSON.parse(response.content) as { statuses: Array<Record<string, unknown>> };
  if ('missing' in statuses[0]) {
    fail('stripped null: response still contains missing key', JSON.stringify(statuses[0]));
  } else {
    pass('stripped null: missing key absent from openai response');
  }
  checkDenormalizeLogEntry(fileLines);
}

async function checkAnthropicPassthrough(originalAppend: typeof logFileWriter.appendToLogFile): Promise<void> {
  const content = JSON.stringify(PAYLOAD_WITH_NULL);
  const { service } = buildService(content, 'anthropic', 'claude-sonnet-4-6');
  const response = await service.execute({
    prompt: 'assess', provider: 'anthropic', model: 'claude-sonnet-4-6', structuredOutput: STRUCTURED_OUTPUT,
  });
  (logFileWriter as Record<string, unknown>).appendToLogFile = originalAppend;
  if (response.content === content) {
    pass('anthropic passthrough: content byte-identical, no strip');
  } else {
    fail('anthropic passthrough: content was modified', response.content);
  }
}

async function checkFencedJson(originalAppend: typeof logFileWriter.appendToLogFile): Promise<void> {
  const fenced = '```json\n' + JSON.stringify(PAYLOAD_WITH_NULL) + '\n```';
  const { service } = buildService(fenced, 'openai', 'gpt-5.4');
  const response = await service.execute({
    prompt: 'assess', stage: 'implement', provider: 'openai', model: 'gpt-5.4', structuredOutput: STRUCTURED_OUTPUT,
  });
  (logFileWriter as Record<string, unknown>).appendToLogFile = originalAppend;
  const { statuses } = JSON.parse(response.content) as { statuses: Array<Record<string, unknown>> };
  if ('missing' in statuses[0]) {
    fail('fenced json: null not stripped from fenced response', JSON.stringify(statuses[0]));
  } else {
    pass('fenced json: null stripped correctly from fenced openai response');
  }
}

async function checkNonJsonPassthrough(originalAppend: typeof logFileWriter.appendToLogFile): Promise<void> {
  const { service } = buildService('not json at all', 'openai', 'gpt-5.4');
  let result: { content: string } = { content: '' };
  let threw = false;
  try {
    result = await service.execute({
      prompt: 'assess', provider: 'openai', model: 'gpt-5.4', structuredOutput: STRUCTURED_OUTPUT,
    });
  } catch {
    threw = true;
  }
  (logFileWriter as Record<string, unknown>).appendToLogFile = originalAppend;
  checkNonJsonResult(threw, result.content);
}

async function checkNoStructuredOutputPassthrough(originalAppend: typeof logFileWriter.appendToLogFile): Promise<void> {
  const content = JSON.stringify(PAYLOAD_WITH_NULL);
  const { service, fileLines } = buildService(content, 'openai', 'gpt-5.4');
  const response = await service.execute({ prompt: 'assess', provider: 'openai', model: 'gpt-5.4' });
  (logFileWriter as Record<string, unknown>).appendToLogFile = originalAppend;
  if (response.content === content) {
    pass('no structuredOutput: content byte-identical when structuredOutput absent');
  } else {
    fail('no structuredOutput: content was modified', response.content);
  }
  checkNoDenormalizeLog(fileLines, 'no structuredOutput');
}

async function main(): Promise<void> {
  console.log(chalk.bold('\nOpenAI structured-output denormalization smoke test\n'));
  const originalAppend = logFileWriter.appendToLogFile;
  try {
    await checkNullsStripped(originalAppend);
    await checkAnthropicPassthrough(originalAppend);
    await checkFencedJson(originalAppend);
    await checkNonJsonPassthrough(originalAppend);
    await checkNoStructuredOutputPassthrough(originalAppend);
  } finally {
    (logFileWriter as Record<string, unknown>).appendToLogFile = originalAppend;
  }
  summarise(counts);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
