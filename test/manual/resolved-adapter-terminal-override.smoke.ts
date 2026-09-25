/**
 * Manual smoke test: per-stage provider appears on terminal, not global default
 *
 * Run: nr test:manual resolved-adapter-terminal-override.smoke.ts
 *
 * Verifies that when the adapter resolves a provider different from the global
 * default, the terminal line reflects the stage-specific provider and model —
 * not the global default.
 */
import chalk from 'chalk';
import { AiService } from '../../src/integrations/ai/ai.service';
import { LoggerService } from '../../src/shared/logger/logger.service';
import type { LlmAdapter } from '../../src/integrations/ai/llm-adapter.interface';
import type { ConfigService } from '@nestjs/config';
import * as logFileWriter from '../../src/shared/logger/log-file-writer';
import { createReporter, summarise } from './support/reporter';

const GLOBAL_PROVIDER = 'anthropic';
const GLOBAL_MODEL = 'claude-sonnet-4-6';
const STAGE_PROVIDER = 'openai';
const STAGE_MODEL = 'gpt-4o';

const { counts, pass, fail } = createReporter();

const stripAnsi = (s: string): string =>
  // eslint-disable-next-line no-control-regex
  s.replaceAll(/\x1b\[[0-9;]*m/g, '');

function buildConfigService(): ConfigService {
  return {
    get: (key: string, defaultValue?: unknown) => {
      const values: Record<string, unknown> = {
        'logging.level': 'info',
        'ai.provider': GLOBAL_PROVIDER,
        'ai.model': GLOBAL_MODEL,
        'ai.stages.review.provider': STAGE_PROVIDER,
        'ai.stages.review.model': STAGE_MODEL,
      };
      return key in values ? values[key] : defaultValue;
    },
  } as unknown as ConfigService;
}

function buildAdapter(provider: string, model: string): LlmAdapter {
  return {
    execute: async () => ({ content: 'ok', provider, model, usage: { inputTokens: 20, outputTokens: 10 } }),
    executeWithHistory: async () => ({ content: 'ok', provider, model, usage: { inputTokens: 20, outputTokens: 10 } }),
  };
}

async function captureConsoleLogs(fn: () => Promise<void>): Promise<string[]> {
  const lines: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => lines.push(stripAnsi(String(args[0])));
  try {
    await fn();
  } finally {
    console.log = original;
  }
  return lines;
}

function checkGlobalProviderAbsent(terminalLines: string[]): void {
  const globalProviderPresent = terminalLines.some(l => /resolved-provider=anthropic/.test(l));
  const leakedLines = terminalLines.filter(l => /resolved-provider/.test(l)).join(' | ');
  if (globalProviderPresent) {
    fail('global provider leaked into terminal line', leakedLines);
  } else {
    pass('global default provider=anthropic does not leak into terminal line');
  }
}

function checkTerminalLines(terminalLines: string[]): void {
  const stageMatch = terminalLines.some(l =>
    /ℹ llm\.adapter resolved-provider=openai resolved-model=gpt-4o/.test(l),
  );
  if (stageMatch) {
    pass('terminal shows stage-specific provider=openai and model=gpt-4o');
  } else {
    fail('terminal did not show stage-specific provider/model', terminalLines.join(' | ') || '(none)');
  }
  checkGlobalProviderAbsent(terminalLines);
}

function checkFileLines(fileLines: string[]): void {
  const fileCostLine = fileLines.some(l => /resolved-provider=openai resolved-model=gpt-4o.*cost=/.test(l));
  if (fileCostLine) {
    pass('log file entry includes stage provider=openai, model=gpt-4o, and cost=');
  } else {
    fail('log file entry missing expected stage provider/model or cost', fileLines.join(' | ') || '(none)');
  }
  const fileGlobalProviderPresent = fileLines.some(l => /resolved-provider=anthropic/.test(l));
  if (fileGlobalProviderPresent) {
    fail('global provider leaked into log file entry', fileLines.join(' | '));
  } else {
    pass('log file entry does not contain global provider=anthropic');
  }
}

async function runScenario(service: AiService, fileLines: string[]): Promise<void> {
  const terminalLines = await captureConsoleLogs(async () => {
    await service.execute({ prompt: 'test', stage: 'review' });
  });
  checkTerminalLines(terminalLines);
  checkFileLines(fileLines);
}

function buildService(): AiService {
  const configService = buildConfigService();
  return new AiService(
    new LoggerService(configService),
    buildAdapter(STAGE_PROVIDER, STAGE_MODEL),
    configService,
  );
}

function makeLogCapture(fileLines: string[]) {
  return (level: string, message: string, context?: string) => {
    fileLines.push(`[${level}] [${context ?? ''}] ${message}`);
  };
}

async function main(): Promise<void> {
  console.log(chalk.bold('\nResolved adapter terminal override smoke test\n'));
  const service = buildService();
  const fileLines: string[] = [];
  const originalAppend = logFileWriter.appendToLogFile;
  (logFileWriter as Record<string, unknown>).appendToLogFile = makeLogCapture(fileLines);
  try {
    await runScenario(service, fileLines);
  } finally {
    (logFileWriter as Record<string, unknown>).appendToLogFile = originalAppend;
  }
  summarise(counts);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
