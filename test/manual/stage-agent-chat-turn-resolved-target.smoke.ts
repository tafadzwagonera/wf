/**
 * Manual smoke test: chatTurn emits resolved-provider terminal line after any dispatch branch
 *
 * Run: nr test:manual stage-agent-chat-turn-resolved-target.smoke.ts
 *
 * Verifies that after the chatTurn refactor, the resolved-provider line appears on the terminal
 * for the anthropic-agent and openai-agent dispatch branches. Private dispatch methods are
 * monkey-patched to return immediately without network calls.
 */
import chalk from 'chalk';
import { StageAgentService } from '../../src/integrations/ai/stage-agent.service';
import type { AgentChatSession } from '../../src/integrations/ai/stage-agent.service';
import type { ConfigService } from '@nestjs/config';
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

const stubSession: AgentChatSession = { provider: 'anthropic' };
const stubResult = { content: 'ok', session: stubSession };

function checkAnthropicResolvedLine(anthropicLines: string[]): void {
  const anthropicMatch = anthropicLines.some(l =>
    /ℹ llm\.adapter resolved-provider=anthropic resolved-model=claude-sonnet-[\w-]+/.test(l),
  );
  if (anthropicMatch) {
    pass('anthropic agent branch: terminal shows resolved-provider=anthropic with a claude-sonnet model');
  } else {
    fail('anthropic agent branch: terminal missing resolved-provider line', anthropicLines.join(' | ') || '(none)');
  }
}

async function runAnthropicBranch(): Promise<void> {
  const anthropicService = new StageAgentService(
    buildConfigService({ 'ai.provider': 'anthropic', 'ai.model': 'claude-sonnet-4-6', 'stages.plan.backend': 'agent' }),
  );
  const anthropicInstance = anthropicService as unknown as Record<string, unknown>;
  const originalAnthropicChatTurn = anthropicInstance['anthropicChatTurn'];
  anthropicInstance['anthropicChatTurn'] = async () => stubResult;
  const anthropicLines = await captureConsoleLogs(async () => {
    await anthropicService.chatTurn({ stage: 'plan', systemPrompt: 'system', userMessage: 'hello' });
  });
  checkAnthropicResolvedLine(anthropicLines);
  anthropicInstance['anthropicChatTurn'] = originalAnthropicChatTurn;
}

function checkOpenaiResolvedLine(openaiLines: string[]): void {
  const openaiMatch = openaiLines.some(l =>
    /ℹ llm\.adapter resolved-provider=openai resolved-model=gpt-5\.5/.test(l));
  if (openaiMatch) {
    pass('openai agent branch: terminal shows resolved-provider=openai resolved-model=gpt-5.5');
  } else {
    fail('openai agent branch: terminal missing resolved-provider line', openaiLines.join(' | ') || '(none)');
  }
  const anthropicPresent = openaiLines.some(l => /resolved-provider=anthropic/.test(l));
  if (anthropicPresent) {
    fail('openai agent branch: anthropic provider leaked into terminal', openaiLines.join(' | '));
  } else {
    pass('openai agent branch: anthropic provider does not appear in terminal output');
  }
}

async function runOpenAiBranch(): Promise<void> {
  const openaiService = new StageAgentService(
    buildConfigService({ 'ai.provider': 'openai', 'ai.providers': [{ provider: 'openai', model: 'gpt-5.5' }], 'stages.plan.backend': 'agent' }),
  );
  const openaiInstance = openaiService as unknown as Record<string, unknown>;
  const originalValidateAndReturn = openaiInstance['validateAndReturnOpenAiChat'];
  openaiInstance['validateAndReturnOpenAiChat'] = async () => ({ ...stubResult, session: { provider: 'openai' } });
  const openaiLines = await captureConsoleLogs(async () => {
    await openaiService.chatTurn({ stage: 'plan', systemPrompt: 'system', userMessage: 'hello' });
  });
  checkOpenaiResolvedLine(openaiLines);
  openaiInstance['validateAndReturnOpenAiChat'] = originalValidateAndReturn;
}

async function main(): Promise<void> {
  console.log(chalk.bold('\nStageAgentService chatTurn resolved target smoke test\n'));
  await runAnthropicBranch();
  await runOpenAiBranch();
  summarise(counts);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
