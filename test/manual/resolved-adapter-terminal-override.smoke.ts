/**
 * Manual smoke test: per-stage provider appears on terminal, not global default
 *
 * Run: nr test:manual -- resolved-adapter-terminal-override
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
import { createReporter } from './support/reporter';

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

async function main(): Promise<void> {
  console.log(chalk.bold('\nResolved adapter terminal override smoke test\n'));

  const configService = buildConfigService();
  const loggerService = new LoggerService(configService);
  const adapter = buildAdapter(STAGE_PROVIDER, STAGE_MODEL);
  const service = new AiService(loggerService, adapter, configService);

  const fileLines: string[] = [];
  const originalAppend = logFileWriter.appendToLogFile;
  (logFileWriter as Record<string, unknown>).appendToLogFile = (
    level: string,
    message: string,
    context?: string,
  ) => fileLines.push(`[${level}] [${context ?? ''}] ${message}`);

  try {
    const terminalLines = await captureConsoleLogs(async () => {
      await service.execute({ prompt: 'test', stage: 'review' });
    });

    const stageMatch = terminalLines.some(l =>
      /ℹ llm\.adapter resolved-provider=openai resolved-model=gpt-4o/.test(l),
    );
    if (stageMatch) {
      pass('terminal shows stage-specific provider=openai and model=gpt-4o');
    } else {
      fail('terminal did not show stage-specific provider/model', terminalLines.join(' | ') || '(none)');
    }

    const globalProviderAbsent = !terminalLines.some(l => /resolved-provider=anthropic/.test(l));
    if (globalProviderAbsent) {
      pass('global default provider=anthropic does not leak into terminal line');
    } else {
      fail('global provider leaked into terminal line', terminalLines.filter(l => /resolved-provider/.test(l)).join(' | '));
    }

    const fileCostLine = fileLines.some(l =>
      /resolved-provider=openai resolved-model=gpt-4o.*cost=/.test(l),
    );
    if (fileCostLine) {
      pass('log file entry includes stage provider=openai, model=gpt-4o, and cost=');
    } else {
      fail('log file entry missing expected stage provider/model or cost', fileLines.join(' | ') || '(none)');
    }

    const fileGlobalProviderAbsent = !fileLines.some(l => /resolved-provider=anthropic/.test(l));
    if (fileGlobalProviderAbsent) {
      pass('log file entry does not contain global provider=anthropic');
    } else {
      fail('global provider leaked into log file entry', fileLines.join(' | '));
    }
  } finally {
    (logFileWriter as Record<string, unknown>).appendToLogFile = originalAppend;
  }

  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`Results: ✓ ${counts.passed} passed   ✗ ${counts.failed} failed`);
  if (counts.failed === 0) console.log('✓ All tests passed!');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  if (counts.failed > 0) process.exit(1);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
