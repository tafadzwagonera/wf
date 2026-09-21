/**
 * Manual smoke test: StageAgentService emits yellow fallback notice and WARN log when model is unavailable
 *
 * Run: nr test:manual -- stage-agent-model-fallback
 *
 * Verifies that when the underlying backend throws a model-unavailable AiProviderError,
 * the service retries once with the fallback model from `ai.providers`, emits a yellow
 * chalk notice to the terminal, writes a WARN log entry, and emits the resolved-provider
 * INFO line exactly once (guard suppresses it on the fallback retry).
 */
import chalk from 'chalk';
import { StageAgentService } from '../../src/integrations/ai/stage-agent.service';
import { AiProviderError } from '../../src/shared/utils/errors';
import type { ConfigService } from '@nestjs/config';
import * as logFileWriter from '../../src/shared/logger/log-file-writer';
import { createReporter } from './support/reporter';

const { counts, pass, fail } = createReporter();

const stripAnsi = (s: string): string =>
  // eslint-disable-next-line no-control-regex
  s.replaceAll(/\x1b\[[0-9;]*m/g, '');

function buildConfigService(): ConfigService {
  return {
    get: (key: string, defaultValue?: unknown) => {
      const values: Record<string, unknown> = {
        'stages.generate.backend': 'cli',
        'stages.generate.provider': 'openai',
        'stages.generate.model': 'codex-v1',
        'ai.provider': 'openai',
        'ai.model': 'gpt-4o',
        'ai.providers': [{ provider: 'openai', model: 'gpt-4o' }],
      };
      return key in values ? values[key] : defaultValue;
    },
  } as unknown as ConfigService;
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
  console.log(chalk.bold('\nStageAgentService model fallback smoke test\n'));

  const svc = new StageAgentService(buildConfigService());
  const instance = svc as unknown as Record<string, unknown>;

  const logLines: string[] = [];
  const originalAppend = logFileWriter.appendToLogFile;
  (logFileWriter as Record<string, unknown>).appendToLogFile = (
    level: string,
    message: string,
    context?: string,
  ) => logLines.push(`[${level}] [${context ?? ''}] ${message}`);

  const originalDispatch = instance['dispatchToBackend'];
  let dispatchCount = 0;
  let secondCallOverride: unknown;
  instance['dispatchToBackend'] = async (params: Record<string, unknown>) => {
    dispatchCount++;
    if (dispatchCount === 1) {
      throw new AiProviderError('model codex-v1 not found', undefined, true, 'api');
    }
    secondCallOverride = params['modelOverride'];
    return { content: 'fallback result' };
  };

  let result: { content: string } | undefined;
  let terminalLines: string[] = [];

  try {
    terminalLines = await captureConsoleLogs(async () => {
      result = await svc.generateFromPrompt('generate a ticket');
    });
  } finally {
    instance['dispatchToBackend'] = originalDispatch;
    (logFileWriter as Record<string, unknown>).appendToLogFile = originalAppend;
  }

  if (result?.content === 'fallback result') {
    pass('generateFromPrompt resolves with fallback content');
  } else {
    fail('generateFromPrompt did not resolve with fallback content', String(result?.content));
  }

  if (dispatchCount === 2) {
    pass('dispatchToBackend called exactly twice — initial attempt and fallback retry');
  } else {
    fail(`dispatchToBackend called ${dispatchCount} times, expected 2`);
  }

  if (secondCallOverride === 'gpt-4o') {
    pass('fallback retry carries modelOverride=gpt-4o');
  } else {
    fail('fallback retry did not carry expected modelOverride', String(secondCallOverride));
  }

  const yellowNotice = terminalLines.some(
    l => /\[stage-agent\] Model unavailable/.test(l) && /fallback-model=gpt-4o/.test(l),
  );
  if (yellowNotice) {
    pass('terminal shows yellow fallback notice with fallback-model=gpt-4o');
  } else {
    fail('terminal missing yellow fallback notice', terminalLines.join(' | ') || '(none)');
  }

  const warnEntry = logLines.find(
    l => l.includes('[WARN]') && l.includes('[stage-agent]') && l.includes('stage-agent.model.fallback'),
  );
  if (warnEntry?.includes('original-model=codex-v1') && warnEntry.includes('fallback-model=gpt-4o')) {
    pass('WARN log contains stage-agent.model.fallback, original-model=codex-v1, fallback-model=gpt-4o');
  } else {
    fail('WARN log missing expected tokens', warnEntry ?? '(no match)');
  }

  const resolvedLines = terminalLines.filter(l => /ℹ llm\.adapter resolved-provider=/.test(l));
  if (resolvedLines.length === 1) {
    pass('ℹ llm.adapter resolved line emitted once — guard suppresses it on fallback retry');
  } else {
    fail(
      `ℹ llm.adapter resolved line count: expected 1, got ${resolvedLines.length}`,
      resolvedLines.join(' | ') || '(none)',
    );
  }

  const infoLlmAdapterEntries = logLines.filter(
    l => l.includes('[INFO]') && l.includes('[llm-adapter]') && l.includes('resolved-provider='),
  );
  if (infoLlmAdapterEntries.length === 1) {
    pass('log file contains exactly one INFO llm-adapter resolved-provider entry');
  } else {
    fail(
      `log file INFO llm-adapter count: expected 1, got ${infoLlmAdapterEntries.length}`,
      infoLlmAdapterEntries.join(' | ') || '(none)',
    );
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
