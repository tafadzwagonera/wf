/**
 * Manual smoke tests for stage-aware follow-up chat routing.
 *
 * Verifies:
 * 1. Standard path: stage is forwarded to executeWithHistory when agent mode is off
 * 2. Agent path: chatTurn is called when agent mode is on
 * 3. Agent session is carried across turns
 * 4. Fallback: no stage means global default (no agent check)
 * 5. Unsupported provider falls back to standard path gracefully
 *
 * Run:
 *   yarn test:manual -- test-stage-aware-chat-routing
 */

import { ConversationService } from '../../src/integrations/ai/conversation/conversation.service';
import { ConversationContext } from '../../src/common/types/conversation.types';

interface TrackedCalls {
  calls: any[][];
}

type AnyFn = (...args: any[]) => Promise<any>;

function createMultiResponseFn(responses: any[]): {
  fn: (...args: any[]) => Promise<any>;
  tracked: TrackedCalls;
} {
  const tracked: TrackedCalls = { calls: [] };
  let index = 0;
  const fn = async (...args: any[]) => {
    tracked.calls.push(args);
    const result = responses[Math.min(index, responses.length - 1)];
    index++;
    return typeof result === 'function' ? result() : result;
  };
  return { fn, tracked };
}

function createTrackedFn(returnValue: any): {
  fn: (...args: any[]) => Promise<any>;
  tracked: TrackedCalls;
} {
  const tracked: TrackedCalls = { calls: [] };
  const fn = async (...args: any[]) => {
    tracked.calls.push(args);
    return returnValue;
  };
  return { fn, tracked };
}

function createSyncTrackedFn(returnValue: any): {
  fn: (...args: any[]) => any;
  tracked: TrackedCalls;
} {
  const tracked: TrackedCalls = { calls: [] };
  const fn = (...args: any[]) => {
    tracked.calls.push(args);
    return returnValue;
  };
  return { fn, tracked };
}

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

const mockLogger = {
  debug: () => undefined,
  error: () => undefined,
  warn: () => undefined,
  log: () => undefined,
};

function makeDisplayAdapter(promptUserInput: AnyFn,
  displayAssistantResponse: AnyFn = async () => undefined,
): any {
  return {
    displayChatIntro: () => undefined,
    promptUserInput,
    displayAssistantResponse,
    displayTokenUsage: () => undefined,
    displayConversationHistory: () => undefined,
    displayHelp: () => undefined,
    displayChatEnd: () => undefined,
    displayError: () => undefined,
    displayMaxTurnsReached: () => undefined,
  };
}

function makeService(executeWithHistory: any, displayAdapter: any, agentService: any): ConversationService {
  const service = new ConversationService(
    { executeWithHistory } as any,
    displayAdapter,
    mockLogger as any,
    agentService,
  );
  service.saveConversation = async () => undefined as any;
  return service;
}

function assertTest1StandardPath(
  executeWithHistory: { tracked: TrackedCalls },
  chatTurn: { tracked: TrackedCalls },
): void {
  assert(executeWithHistory.tracked.calls.length === 1, `Expected executeWithHistory called once, got ${executeWithHistory.tracked.calls.length}`);
  const request = executeWithHistory.tracked.calls[0][0];
  assert(request.stage === 'review', `Expected stage 'review', got '${request.stage}'`);
  assert(chatTurn.tracked.calls.length === 0, 'Expected chatTurn NOT called');
  console.log('  Test 1 passed: standard path routes with stage');
}

async function runTest1StandardPath(): Promise<void> {
  const executeWithHistory = createTrackedFn({ content: 'standard response', usage: { inputTokens: 10, outputTokens: 5 } });
  const isEnabledForStage = createSyncTrackedFn(false);
  const chatTurn = createTrackedFn({ content: 'agent response', session: { provider: 'anthropic', sessionId: 'sess-1' } });
  const promptUserInput = createMultiResponseFn([{ input: 'explain the issue', shouldExit: false }, { input: '', shouldExit: true }]);
  const service = makeService(
    executeWithHistory.fn,
    makeDisplayAdapter(promptUserInput.fn),
    { isEnabledForStage: isEnabledForStage.fn, chatTurn: chatTurn.fn } as any,
  );
  const context: ConversationContext = { ticketKey: 'TEST-1', stage: 'review', repoDir: '/tmp/test-repo', workflowState: { ticketContent: 'test' } };
  const conv = await service.createConversation('TEST-1', context);
  await service.startChatSession(conv.conversationId, { systemPrompt: 'You are a reviewer', stage: 'review', repoDir: '/tmp/test-repo' });
  assertTest1StandardPath(executeWithHistory, chatTurn);
}

function assertTest2RoutingCalls(chatTurn: TrackedCalls, executeWithHistory: TrackedCalls): void {
  assert(chatTurn.calls.length === 1, `Expected chatTurn called once, got ${chatTurn.calls.length}`);
  const args = chatTurn.calls[0][0];
  assert(args.stage === 'review', `Expected stage 'review', got '${args.stage}'`);
  assert(args.userMessage === 'what is the trace?', `Expected user message forwarded, got '${args.userMessage}'`);
  assert(args.repoDir === '/tmp/test-repo', `Expected repoDir '/tmp/test-repo', got '${args.repoDir}'`);
  assert(executeWithHistory.calls.length === 0, 'Expected executeWithHistory NOT called');
}

function assertTest2State(
  service: ConversationService,
  convId: string,
  displayAssistantResponse: TrackedCalls,
): void {
  const state = service.getConversation(convId);
  const lastMsg = state?.messages.at(-1);
  assert(lastMsg?.role === 'assistant' && lastMsg?.content === 'agent response', 'Expected agent response persisted');
  const displayedMsg = displayAssistantResponse.calls[0][0];
  assert(displayedMsg.content === 'agent response', 'Expected agent response displayed');
  console.log('  Test 2 passed: agent path routes through chatTurn');
}

async function startTest2Session(service: ConversationService): Promise<string> {
  const context: ConversationContext = { ticketKey: 'TEST-2', stage: 'review', repoDir: '/tmp/test-repo', workflowState: { ticketContent: 'test' } };
  const conv = await service.createConversation('TEST-2', context);
  await service.startChatSession(conv.conversationId, { systemPrompt: 'You are a reviewer', stage: 'review', repoDir: '/tmp/test-repo' });
  return conv.conversationId;
}

async function runTest2AgentPath(): Promise<void> {
  const executeWithHistory = createTrackedFn({ content: 'standard response', usage: { inputTokens: 10, outputTokens: 5 } });
  const chatTurn = createTrackedFn({ content: 'agent response', session: { provider: 'anthropic', sessionId: 'sess-abc' } });
  const promptUserInput = createMultiResponseFn([{ input: 'what is the trace?', shouldExit: false }, { input: '', shouldExit: true }]);
  const displayAssistantResponse = createTrackedFn(undefined);
  const service = makeService(
    executeWithHistory.fn,
    makeDisplayAdapter(promptUserInput.fn, displayAssistantResponse.fn),
    { isEnabledForStage: createSyncTrackedFn(true).fn, chatTurn: chatTurn.fn } as any,
  );
  const convId = await startTest2Session(service);
  assertTest2RoutingCalls(chatTurn.tracked, executeWithHistory.tracked);
  assertTest2State(service, convId, displayAssistantResponse.tracked);
}

function assertTest3SessionCarried(chatTurn: { tracked: TrackedCalls }): void {
  assert(chatTurn.tracked.calls.length === 2, `Expected 2 chatTurn calls, got ${chatTurn.tracked.calls.length}`);
  assert(chatTurn.tracked.calls[0][0].session === undefined, 'Expected first call has no session');
  const secondSession = chatTurn.tracked.calls[1][0].session;
  assert(secondSession?.provider === 'openai', `Expected provider 'openai', got '${secondSession?.provider}'`);
  assert(secondSession?.runState?.id === 'rs-1', 'Expected runState from first turn carried');
  console.log('  Test 3 passed: agent session carried across turns');
}

async function runTest3SessionCarried(): Promise<void> {
  const chatTurn = createMultiResponseFn([
    { content: 'turn 1 response', session: { provider: 'openai', sessionId: 'sess-1', runState: { id: 'rs-1' } } },
    { content: 'turn 2 response', session: { provider: 'openai', sessionId: 'sess-1', runState: { id: 'rs-2' } } },
  ]);
  const promptUserInput = createMultiResponseFn([{ input: 'turn 1', shouldExit: false }, { input: 'turn 2', shouldExit: false }, { input: '', shouldExit: true }]);
  const service = makeService(async () => ({ content: '', usage: null }), makeDisplayAdapter(promptUserInput.fn), { isEnabledForStage: () => true, chatTurn: chatTurn.fn } as any);
  const context: ConversationContext = { ticketKey: 'TEST-3', stage: 'plan', repoDir: '/tmp/test-repo', workflowState: { ticketContent: 'test' } };
  const conv = await service.createConversation('TEST-3', context);
  await service.startChatSession(conv.conversationId, { systemPrompt: 'You are a planner', stage: 'plan', repoDir: '/tmp/test-repo' });
  assertTest3SessionCarried(chatTurn);
}

async function runTest4NoStageSkipsAgentCheck(): Promise<void> {
  const executeWithHistory = createTrackedFn({ content: 'response', usage: { inputTokens: 5, outputTokens: 3 } });
  const isEnabledForStage = createSyncTrackedFn(true);
  const promptUserInput = createMultiResponseFn([{ input: 'hi', shouldExit: false }, { input: '', shouldExit: true }]);
  const service = makeService(executeWithHistory.fn, makeDisplayAdapter(promptUserInput.fn), { isEnabledForStage: isEnabledForStage.fn, chatTurn: async () => ({ content: '', session: {} } as any) } as any);
  const context: ConversationContext = { ticketKey: 'TEST-4', stage: 'review', workflowState: { ticketContent: 'test' } };
  const conv = await service.createConversation('TEST-4', context);
  await service.startChatSession(conv.conversationId, { systemPrompt: 'system' });
  assert(isEnabledForStage.tracked.calls.length === 0, 'Expected isEnabledForStage NOT called when stage omitted');
  assert(executeWithHistory.tracked.calls.length === 1, 'Expected standard path used');
  console.log('  Test 4 passed: no stage skips agent check');
}

function assertTest5FallbackPath(
  chatTurn: { tracked: TrackedCalls },
  executeWithHistory: { tracked: TrackedCalls },
): void {
  assert(chatTurn.tracked.calls.length === 0, 'Expected chatTurn NOT called');
  assert(executeWithHistory.tracked.calls.length === 1, 'Expected fallback to standard path');
  console.log('  Test 5 passed: unsupported provider falls back to standard');
}

async function runTest5UnsupportedProviderFallback(): Promise<void> {
  const executeWithHistory = createTrackedFn({ content: 'fallback response', usage: { inputTokens: 5, outputTokens: 3 } });
  const chatTurn = createTrackedFn({ content: '', session: {} });
  const promptUserInput = createMultiResponseFn([{ input: 'hi', shouldExit: false }, { input: '', shouldExit: true }]);
  const agentService = {
    isEnabledForStage: () => { throw new Error('unsupported provider "google"'); },
    chatTurn: chatTurn.fn,
  } as any;
  const service = makeService(executeWithHistory.fn, makeDisplayAdapter(promptUserInput.fn), agentService);
  const context: ConversationContext = { ticketKey: 'TEST-5', stage: 'review', repoDir: '/tmp/repo', workflowState: { ticketContent: 'test' } };
  const conv = await service.createConversation('TEST-5', context);
  await service.startChatSession(conv.conversationId, { systemPrompt: 'system', stage: 'review', repoDir: '/tmp/repo' });
  assertTest5FallbackPath(chatTurn, executeWithHistory);
}

async function main(): Promise<void> {
  console.log('Manual smoke: stage-aware follow-up chat routing\n');
  await runTest1StandardPath();
  await runTest2AgentPath();
  await runTest3SessionCarried();
  await runTest4NoStageSkipsAgentCheck();
  await runTest5UnsupportedProviderFallback();
  console.log('\nAll stage-aware chat routing smoke tests passed');
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
