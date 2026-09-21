/**
 * Manual smoke test: resolved provider and model appear on terminal after each AI call
 *
 * Run: nr test:manual -- resolved-adapter-terminal-line
 *
 * Verifies that after execute() and executeWithHistory() the terminal receives a blue
 * info line containing the actual resolved provider and model, and that the log file
 * still carries the full message including cost.
 */
import chalk from 'chalk';
import { AiService } from '../../src/integrations/ai/ai.service';
import { LoggerService } from '../../src/shared/logger/logger.service';
import type { LlmAdapter } from '../../src/integrations/ai/llm-adapter.interface';
import type { AIConversationRequest } from '../../src/integrations/ai/ai.service';
import type { ConfigService } from '@nestjs/config';
import * as logFileWriter from '../../src/shared/logger/log-file-writer';
import { createReporter } from './support/reporter';

const PROVIDER = 'anthropic';
const MODEL = 'claude-sonnet-4-6';

const { counts, pass, fail } = createReporter();

const stripAnsi = (s: string): string =>
  // eslint-disable-next-line no-control-regex
  s.replaceAll(/\x1b\[[0-9;]*m/g, '');

function buildConfigService(): ConfigService {
  return {
    get: (key: string, defaultValue?: unknown) => {
      const values: Record<string, unknown> = {
        'logging.level': 'info',
        'ai.provider': PROVIDER,
        'ai.model': MODEL,
      };
      return key in values ? values[key] : defaultValue;
    },
  } as unknown as ConfigService;
}

function buildAdapter(provider: string, model: string): LlmAdapter {
  return {
    execute: async () => ({ content: 'ok', provider, model, usage: { inputTokens: 10, outputTokens: 5 } }),
    executeWithHistory: async () => ({ content: 'ok', provider, model, usage: { inputTokens: 10, outputTokens: 5 } }),
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
  console.log(chalk.bold('\nResolved adapter terminal line smoke test\n'));

  const configService = buildConfigService();
  const loggerService = new LoggerService(configService);
  const adapter = buildAdapter(PROVIDER, MODEL);
  const service = new AiService(loggerService, adapter, configService);

  const fileLines: string[] = [];
  const originalAppend = logFileWriter.appendToLogFile;
  (logFileWriter as Record<string, unknown>).appendToLogFile = (
    level: string,
    message: string,
    context?: string,
  ) => fileLines.push(`[${level}] [${context ?? ''}] ${message}`);

  try {
    const executeLines = await captureConsoleLogs(async () => {
      await service.execute({ prompt: 'test', stage: 'plan' });
    });

    const executeMatch = executeLines.some(l =>
      /ℹ llm\.adapter resolved-provider=anthropic resolved-model=claude-sonnet-4-6/.test(l),
    );
    if (executeMatch) {
      pass('execute() emits ℹ llm.adapter resolved-provider and resolved-model on terminal');
    } else {
      fail('execute() did not emit resolved-provider/resolved-model on terminal', executeLines.join(' | ') || '(none)');
    }

    const hasPlaceholders = executeLines.some(l => l.includes('{provider}') || l.includes('{model}'));
    if (hasPlaceholders) {
      fail('execute() terminal output contains literal placeholder strings', executeLines.join(' | '));
    } else {
      pass('execute() terminal output contains no literal placeholder strings');
    }

    fileLines.length = 0;
    const historyLines = await captureConsoleLogs(async () => {
      await service.executeWithHistory({
        messages: [{ role: 'user', content: 'test' }],
        stage: 'plan',
      } as unknown as AIConversationRequest);
    });

    const historyMatch = historyLines.some(l =>
      /ℹ llm\.adapter resolved-provider=anthropic resolved-model=claude-sonnet-4-6/.test(l),
    );
    if (historyMatch) {
      pass('executeWithHistory() emits ℹ llm.adapter resolved-provider and resolved-model on terminal');
    } else {
      fail('executeWithHistory() did not emit resolved-provider/resolved-model on terminal', historyLines.join(' | ') || '(none)');
    }

    const fileCostLine = fileLines.some(l => /resolved-provider=anthropic.*cost=/.test(l));
    if (fileCostLine) {
      pass('log file entry includes cost= field alongside resolved-provider');
    } else {
      fail('log file entry missing cost= field', fileLines.join(' | ') || '(none)');
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
