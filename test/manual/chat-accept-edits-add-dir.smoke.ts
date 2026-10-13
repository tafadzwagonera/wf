/**
 * Manual smoke test for interactive chat edit permissions.
 *
 * Verifies:
 * 1. ConversationService.processAgentTurn passes allowEdits and artifactDir to chatTurn
 * 2. The real Claude CLI chat args for an allowEdits pass contain --permission-mode acceptEdits,
 *    Edit, Write and --add-dir <artifactDir>
 * 3. A non-chat chatTurn consumer (no allowEdits) still emits --permission-mode plan
 *
 * Run:
 *   nr test:manual chat-accept-edits-add-dir.smoke
 */

import type { ConfigService } from '@nestjs/config';
import { ConversationService } from '../../src/integrations/ai/conversation/conversation.service';
import { StageAgentService } from '../../src/integrations/ai/stage-agent.service';
import { ConversationContext } from '../../src/shared/types/conversation.types';

const assert = (condition: boolean, message: string): void => {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
};

const noop = () => undefined;
const mockLogger = { debug: noop, error: noop, warn: noop, log: noop };

const argAfter = (args: string[], flag: string): string | undefined => args[args.indexOf(flag) + 1];

const buildChatUi = (inputs: Array<{ input: string; shouldExit: boolean }>) => ({
  displayChatIntro: noop, displayAssistantResponse: noop, displayTokenUsage: noop,
  displayConversationHistory: noop, displayHelp: noop, displayChatEnd: noop,
  displayError: noop, displayMaxTurnsReached: noop,
  promptUserInput: async () => inputs.shift(),
});

const chatContext: ConversationContext = {
  ticketKey: 'shop-fix', stage: 'plan', repoDir: '/tmp/repo', artifactDir: '/tmp/wf/shop',
  workflowState: { ticketContent: 'smoke' },
};

const runInteractiveChat = async (chatTurnCalls: Array<Record<string, unknown>>): Promise<void> => {
  const stageAgent = {
    isEnabledForStage: () => true,
    chatTurn: async (params: Record<string, unknown>) => {
      chatTurnCalls.push(params);
      return { content: 'ok', session: { provider: 'anthropic', sessionId: 's1' } };
    },
  };
  const chatUi = buildChatUi([{ input: 'edit the plan', shouldExit: false }, { input: '', shouldExit: true }]);
  const service = new ConversationService({} as any, chatUi as any, mockLogger as any, stageAgent as any);
  service.saveConversation = async () => undefined;
  const conversation = await service.createConversation('shop-fix', chatContext);
  await service.startChatSession(conversation.conversationId, { stage: 'plan', repoDir: '/tmp/repo', systemPrompt: 's' });
};

const testConversationForwardsFlags = async (): Promise<void> => {
  const chatTurnCalls: Array<Record<string, unknown>> = [];
  await runInteractiveChat(chatTurnCalls);
  assert(chatTurnCalls.length === 1, `Expected one chatTurn call, got ${chatTurnCalls.length}`);
  assert(chatTurnCalls[0].allowEdits === true, 'Expected allowEdits true for interactive chat');
  assert(chatTurnCalls[0].artifactDir === '/tmp/wf/shop', 'Expected artifactDir forwarded to chatTurn');
  console.log('  Test 1 passed: interactive chat requests edits and the artifact dir');
};

const buildChatArgs = (opts: Record<string, unknown>): string[] => {
  const configService = { get: (_key: string, defaultValue?: unknown) => defaultValue } as unknown as ConfigService;
  const service = new StageAgentService(configService) as any;
  return service.buildCliChatPassArgs(
    { stage: 'plan', model: 'claude-sonnet-4-6', systemPrompt: 's', userMessage: 'hi', passNumber: 1, ...opts },
    'hi', false
  );
};

const testEditArgs = (): void => {
  const args = buildChatArgs({ repoDir: '/tmp/repo', allowEdits: true, artifactDir: '/tmp/wf/shop' });
  assert(argAfter(args, '--permission-mode') === 'acceptEdits', `Expected acceptEdits, got ${args.join(' ')}`);
  const tools = args.join(' ');
  assert(/\bEdit\b/.test(tools) && /\bWrite\b/.test(tools), `Expected Edit and Write in ${tools}`);
  assert(argAfter(args, '--add-dir') === '/tmp/wf/shop', `Expected --add-dir /tmp/wf/shop in ${tools}`);
  console.log('  Test 2 passed: CLI chat args grant acceptEdits, Edit, Write and --add-dir');
};

const testNonChatArgs = (): void => {
  const args = buildChatArgs({ repoDir: '/tmp/repo', artifactDir: '/tmp/wf/shop' });
  assert(argAfter(args, '--permission-mode') === 'plan', `Expected plan, got ${args.join(' ')}`);
  assert(!args.includes('--add-dir'), 'Did not expect --add-dir without allowEdits');
  assert(!/\b(?:Edit|Write)\b/.test(args.join(' ')), 'Did not expect Edit/Write without allowEdits');
  console.log('  Test 3 passed: non-chat consumer still emits --permission-mode plan');
};

const run = async (): Promise<void> => {
  await testConversationForwardsFlags();
  testEditArgs();
  testNonChatArgs();
  console.log('All chat edit permission smoke tests passed');
};

run().catch(error => {
  console.error(error);
  process.exit(1);
});
