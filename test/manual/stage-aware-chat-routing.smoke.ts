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
import { ConversationContext } from '../../src/shared/types/conversation.types';

interface TrackedCalls {
  calls: any[][];
}

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

async function main(): Promise<void> {
  console.log('Manual smoke: stage-aware follow-up chat routing\n');

  {
    const executeWithHistory = createTrackedFn({
      content: 'standard response',
      usage: { inputTokens: 10, outputTokens: 5 },
    });
    const isEnabledForStage = createSyncTrackedFn(false);
    const chatTurn = createTrackedFn({
      content: 'agent response',
      session: { provider: 'anthropic', sessionId: 'sess-1' },
    });
    const promptUserInput = createMultiResponseFn([
      { input: 'explain the issue', shouldExit: false },
      { input: '', shouldExit: true },
    ]);

    const service = new ConversationService(
      { executeWithHistory: executeWithHistory.fn } as any,
      {
        displayChatIntro: () => undefined,
        promptUserInput: promptUserInput.fn,
        displayAssistantResponse: () => undefined,
        displayTokenUsage: () => undefined,
        displayConversationHistory: () => undefined,
        displayHelp: () => undefined,
        displayChatEnd: () => undefined,
        displayError: () => undefined,
        displayMaxTurnsReached: () => undefined,
      } as any,
      mockLogger as any,
      {
        isEnabledForStage: isEnabledForStage.fn,
        chatTurn: chatTurn.fn,
      } as any,
    );
    service.saveConversation = async () => undefined as any;
    const context: ConversationContext = {
      ticketKey: 'TEST-1',
      stage: 'review',
      repoDir: '/tmp/test-repo',
      workflowState: { ticketContent: 'test' },
    };
    const conv = await service.createConversation('TEST-1', context);

    await service.startChatSession(conv.conversationId, {
      systemPrompt: 'You are a reviewer',
      stage: 'review',
      repoDir: '/tmp/test-repo',
    });

    assert(
      executeWithHistory.tracked.calls.length === 1,
      `Expected executeWithHistory called once, got ${executeWithHistory.tracked.calls.length}`,
    );
    const request = executeWithHistory.tracked.calls[0][0];
    assert(request.stage === 'review', `Expected stage 'review', got '${request.stage}'`);
    assert(chatTurn.tracked.calls.length === 0, 'Expected chatTurn NOT called');

    console.log('  Test 1 passed: standard path routes with stage');
  }

  {
    const executeWithHistory = createTrackedFn({
      content: 'standard response',
      usage: { inputTokens: 10, outputTokens: 5 },
    });
    const isEnabledForStage = createSyncTrackedFn(true);
    const chatTurn = createTrackedFn({
      content: 'agent response',
      session: { provider: 'anthropic', sessionId: 'sess-abc' },
    });
    const promptUserInput = createMultiResponseFn([
      { input: 'what is the trace?', shouldExit: false },
      { input: '', shouldExit: true },
    ]);
    const displayAssistantResponse = createTrackedFn(undefined);

    const service = new ConversationService(
      { executeWithHistory: executeWithHistory.fn } as any,
      {
        displayChatIntro: () => undefined,
        promptUserInput: promptUserInput.fn,
        displayAssistantResponse: displayAssistantResponse.fn,
        displayTokenUsage: () => undefined,
        displayConversationHistory: () => undefined,
        displayHelp: () => undefined,
        displayChatEnd: () => undefined,
        displayError: () => undefined,
        displayMaxTurnsReached: () => undefined,
      } as any,
      mockLogger as any,
      {
        isEnabledForStage: isEnabledForStage.fn,
        chatTurn: chatTurn.fn,
      } as any,
    );
    service.saveConversation = async () => undefined as any;
    const context: ConversationContext = {
      ticketKey: 'TEST-2',
      stage: 'review',
      repoDir: '/tmp/test-repo',
      workflowState: { ticketContent: 'test' },
    };
    const conv = await service.createConversation('TEST-2', context);

    await service.startChatSession(conv.conversationId, {
      systemPrompt: 'You are a reviewer',
      stage: 'review',
      repoDir: '/tmp/test-repo',
    });

    assert(
      chatTurn.tracked.calls.length === 1,
      `Expected chatTurn called once, got ${chatTurn.tracked.calls.length}`,
    );
    const args = chatTurn.tracked.calls[0][0];
    assert(args.stage === 'review', `Expected stage 'review', got '${args.stage}'`);
    assert(args.userMessage === 'what is the trace?', `Expected user message forwarded, got '${args.userMessage}'`);
    assert(args.repoDir === '/tmp/test-repo', `Expected repoDir '/tmp/test-repo', got '${args.repoDir}'`);
    assert(executeWithHistory.tracked.calls.length === 0, 'Expected executeWithHistory NOT called');

    // Verify assistant message persisted
    const state = service.getConversation(conv.conversationId);
    const lastMsg = state?.messages.at(-1);
    assert(lastMsg?.role === 'assistant' && lastMsg?.content === 'agent response', 'Expected agent response persisted');

    // Verify displayAssistantResponse received agent message
    const displayedMsg = displayAssistantResponse.tracked.calls[0][0];
    assert(displayedMsg.content === 'agent response', 'Expected agent response displayed');

    console.log('  Test 2 passed: agent path routes through chatTurn');
  }

  {
    const chatTurn = createMultiResponseFn([
      {
        content: 'turn 1 response',
        session: {
          provider: 'openai',
          sessionId: 'sess-1',
          runState: { id: 'rs-1' },
        },
      },
      {
        content: 'turn 2 response',
        session: {
          provider: 'openai',
          sessionId: 'sess-1',
          runState: { id: 'rs-2' },
        },
      },
    ]);
    const promptUserInput = createMultiResponseFn([
      { input: 'turn 1', shouldExit: false },
      { input: 'turn 2', shouldExit: false },
      { input: '', shouldExit: true },
    ]);

    const service = new ConversationService(
      { executeWithHistory: async () => ({ content: '', usage: null }) } as any,
      {
        displayChatIntro: () => undefined,
        promptUserInput: promptUserInput.fn,
        displayAssistantResponse: () => undefined,
        displayTokenUsage: () => undefined,
        displayConversationHistory: () => undefined,
        displayHelp: () => undefined,
        displayChatEnd: () => undefined,
        displayError: () => undefined,
        displayMaxTurnsReached: () => undefined,
      } as any,
      mockLogger as any,
      { isEnabledForStage: () => true, chatTurn: chatTurn.fn } as any,
    );
    service.saveConversation = async () => undefined as any;
    const context: ConversationContext = {
      ticketKey: 'TEST-3',
      stage: 'plan',
      repoDir: '/tmp/test-repo',
      workflowState: { ticketContent: 'test' },
    };
    const conv = await service.createConversation('TEST-3', context);

    await service.startChatSession(conv.conversationId, {
      systemPrompt: 'You are a planner',
      stage: 'plan',
      repoDir: '/tmp/test-repo',
    });

    assert(chatTurn.tracked.calls.length === 2, `Expected 2 chatTurn calls, got ${chatTurn.tracked.calls.length}`);

    // First call: no prior session
    assert(chatTurn.tracked.calls[0][0].session === undefined, 'Expected first call has no session');

    // Second call: carries session from first
    const secondSession = chatTurn.tracked.calls[1][0].session;
    assert(secondSession?.provider === 'openai', `Expected provider 'openai', got '${secondSession?.provider}'`);
    assert(secondSession?.runState?.id === 'rs-1', 'Expected runState from first turn carried');

    console.log('  Test 3 passed: agent session carried across turns');
  }

  {
    const executeWithHistory = createTrackedFn({
      content: 'response',
      usage: { inputTokens: 5, outputTokens: 3 },
    });
    const isEnabledForStage = createSyncTrackedFn(true);
    const promptUserInput = createMultiResponseFn([
      { input: 'hi', shouldExit: false },
      { input: '', shouldExit: true },
    ]);

    const service = new ConversationService(
      { executeWithHistory: executeWithHistory.fn } as any,
      {
        displayChatIntro: () => undefined,
        promptUserInput: promptUserInput.fn,
        displayAssistantResponse: () => undefined,
        displayTokenUsage: () => undefined,
        displayConversationHistory: () => undefined,
        displayHelp: () => undefined,
        displayChatEnd: () => undefined,
        displayError: () => undefined,
        displayMaxTurnsReached: () => undefined,
      } as any,
      mockLogger as any,
      {
        isEnabledForStage: isEnabledForStage.fn,
        chatTurn: async () => ({ content: '', session: {} } as any),
      } as any,
    );
    service.saveConversation = async () => undefined as any;
    const context: ConversationContext = {
      ticketKey: 'TEST-4',
      stage: 'review',
      workflowState: { ticketContent: 'test' },
    };
    const conv = await service.createConversation('TEST-4', context);

    await service.startChatSession(conv.conversationId, {
      systemPrompt: 'system',
    });

    assert(isEnabledForStage.tracked.calls.length === 0, 'Expected isEnabledForStage NOT called when stage omitted');
    assert(executeWithHistory.tracked.calls.length === 1, 'Expected standard path used');

    console.log('  Test 4 passed: no stage skips agent check');
  }

  {
    const executeWithHistory = createTrackedFn({
      content: 'fallback response',
      usage: { inputTokens: 5, outputTokens: 3 },
    });
    const chatTurn = createTrackedFn({ content: '', session: {} });
    const promptUserInput = createMultiResponseFn([
      { input: 'hi', shouldExit: false },
      { input: '', shouldExit: true },
    ]);

    const service = new ConversationService(
      { executeWithHistory: executeWithHistory.fn } as any,
      {
        displayChatIntro: () => undefined,
        promptUserInput: promptUserInput.fn,
        displayAssistantResponse: () => undefined,
        displayTokenUsage: () => undefined,
        displayConversationHistory: () => undefined,
        displayHelp: () => undefined,
        displayChatEnd: () => undefined,
        displayError: () => undefined,
        displayMaxTurnsReached: () => undefined,
      } as any,
      mockLogger as any,
      {
        isEnabledForStage: () => {
          throw new Error('unsupported provider "google"');
        },
        chatTurn: chatTurn.fn,
      } as any,
    );
    service.saveConversation = async () => undefined as any;
    const context: ConversationContext = {
      ticketKey: 'TEST-5',
      stage: 'review',
      repoDir: '/tmp/repo',
      workflowState: { ticketContent: 'test' },
    };
    const conv = await service.createConversation('TEST-5', context);

    await service.startChatSession(conv.conversationId, {
      systemPrompt: 'system',
      stage: 'review',
      repoDir: '/tmp/repo',
    });

    assert(chatTurn.tracked.calls.length === 0, 'Expected chatTurn NOT called');
    assert(executeWithHistory.tracked.calls.length === 1, 'Expected fallback to standard path');

    console.log('  Test 5 passed: unsupported provider falls back to standard');
  }

  console.log('\nAll stage-aware chat routing smoke tests passed');
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
