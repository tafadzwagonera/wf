/**
 * Manual smoke test: StageAgentService.logResolvedStageTarget emits terminal line and log-file entry
 *
 * Run: nr test:manual stage-agent-resolved-target-line.smoke.ts
 *
 * Verifies that logResolvedStageTarget (public) produces the blue ℹ line on the terminal
 * and writes to the log file — using the global default provider and a per-stage override.
 */
import chalk from 'chalk';
import { StageAgentService } from '../../src/integrations/ai/stage-agent.service';
import type { ConfigService } from '@nestjs/config';
import * as logFileWriter from '../../src/shared/logger/log-file-writer';
import { createReporter, summarise } from './support/reporter';

const { counts, pass, fail } = createReporter();

const stripAnsi = (s: string): string =>
  // eslint-disable-next-line no-control-regex
  s.replaceAll(/\x1b\[[0-9;]*m/g, '');

function buildConfigService(values: Record<string, unknown>): ConfigService {
  return {
    get: (key: string, defaultValue?: unknown) =>
      key in values ? values[key] : defaultValue,
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

function checkGlobalDefaultTerminalLine(globalLines: string[]): void {
  const globalMatch = globalLines.some(l =>
    /ℹ llm\.adapter resolved-provider=anthropic resolved-model=claude-sonnet-4-6/.test(l),
  );
  if (globalMatch) {
    pass('global default: terminal shows resolved-provider=anthropic resolved-model=claude-sonnet-4-6');
  } else {
    fail('global default: terminal missing resolved-provider line', globalLines.join(' | ') || '(none)');
  }
}

function checkGlobalDefaultLogEntry(fileLines: string[]): void {
  const globalFileMatch = fileLines.some(l =>
    /\[INFO\] \[llm-adapter\] llm\.adapter resolved-provider=anthropic resolved-model=claude-sonnet-4-6/.test(l),
  );
  if (globalFileMatch) {
    pass('global default: log-file entry has resolved-provider=anthropic resolved-model=claude-sonnet-4-6');
  } else {
    fail('global default: log-file entry missing expected entry', fileLines.join(' | ') || '(none)');
  }
}

async function runGlobalDefaultChecks(fileLines: string[]): Promise<void> {
  const globalService = new StageAgentService(
    buildConfigService({ 'ai.provider': 'anthropic', 'ai.model': 'claude-sonnet-4-6' }),
  );
  const globalLines = await captureConsoleLogs(async () => {
    globalService.logResolvedStageTarget('plan');
  });
  checkGlobalDefaultTerminalLine(globalLines);
  checkGlobalDefaultLogEntry(fileLines);
}

function checkOverrideGlobalAbsent(overrideLines: string[]): void {
  const overrideGlobalPresent = overrideLines.some(l => /resolved-provider=anthropic/.test(l));
  if (overrideGlobalPresent) {
    fail('per-stage override: global provider leaked into terminal', overrideLines.join(' | '));
  } else {
    pass('per-stage override: global provider=anthropic does not appear in terminal output');
  }
}

function checkOverrideTerminalLine(overrideLines: string[]): void {
  const overrideMatch = overrideLines.some(l =>
    /ℹ llm\.adapter resolved-provider=openai resolved-model=gpt-5\.5/.test(l),
  );
  if (overrideMatch) {
    pass('per-stage override: terminal shows resolved-provider=openai resolved-model=gpt-5.5');
  } else {
    fail('per-stage override: terminal missing stage provider line', overrideLines.join(' | ') || '(none)');
  }
  checkOverrideGlobalAbsent(overrideLines);
}

async function runOverrideChecks(fileLines: string[]): Promise<void> {
  fileLines.length = 0;
  const overrideService = new StageAgentService(
    buildConfigService({
      'ai.provider': 'anthropic', 'ai.model': 'claude-sonnet-4-6',
      'stages.review.provider': 'openai', 'stages.review.model': 'gpt-5.5',
    }),
  );
  const overrideLines = await captureConsoleLogs(async () => {
    overrideService.logResolvedStageTarget('review');
  });
  checkOverrideTerminalLine(overrideLines);
}

async function main(): Promise<void> {
  console.log(chalk.bold('\nStageAgentService resolved target line smoke test\n'));
  const fileLines: string[] = [];
  const originalAppend = logFileWriter.appendToLogFile;
  (logFileWriter as Record<string, unknown>).appendToLogFile = (level: string, message: string, context?: string) =>
    fileLines.push(`[${level}] [${context ?? ''}] ${message}`);
  try {
    await runGlobalDefaultChecks(fileLines);
    await runOverrideChecks(fileLines);
  } finally {
    (logFileWriter as Record<string, unknown>).appendToLogFile = originalAppend;
  }
  summarise(counts);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
