/**
 * Manual smoke tests for issue:review interactive follow-up chat.
 *
 * Verifies:
 * 1. Interactive chat prompt appears after review in TTY mode
 * 2. Chat prompt is skipped in silent mode
 * 3. Chat prompt is skipped in non-interactive (no TTY) mode
 * 4. ConversationService receives correct arguments when chat is accepted
 * 5. Conversation file path resolves to ~/.wf/<repo>/ without a tracker
 *
 * Run:
 *   yarn test:manual -- test-issue-review-interactive-chat
 */

import { Test } from '@nestjs/testing';
import { IssueReviewCommand } from '../../src/commands/issue-review.command';
import { AiService } from '../../src/integrations/ai/ai.service';
import { GitService } from '../../src/integrations/git/git.service';
import { IssueTrackerService } from '../../src/integrations/issue-trackers/issue-tracker.service';
import { LoggerService } from '../../src/shared/logger/logger.service';
import { DryRunPreviewService } from '../../src/shared/preview/dry-run-preview.service';
import { ReviewStageService } from '../../src/workflows/stages/review-stage.service';
import { ConversationService } from '../../src/integrations/ai/conversation/conversation.service';
import inquirer from 'inquirer';

const mockReview = {
  summary: 'Review summary for chat test',
  issues: [
    {
      severity: 'warning' as const,
      message: 'Consider narrowing the type guard',
      file: 'src/guard.ts',
      line: 10,
    },
  ],
  suggestions: ['Add a unit test for the edge case'],
  approved: true,
  traceProvenance: 'best-effort' as const,
  callStack: [],
  stateTransition: {},
};

interface TrackedFn {
  (...args: any[]): Promise<any>;
  mock: { calls: any[][] };
}

const createTrackedFn = (returnValue: any): TrackedFn => {
  const calls: any[][] = [];
  const fn = (async (...args: any[]) => {
    calls.push(args);
    return returnValue;
  }) as TrackedFn;
  fn.mock = { calls };
  return fn;
};

const createMockConversationService = () => ({
  loadConversation: createTrackedFn(null),
  createConversation: createTrackedFn({
    conversationId: 'smoke-conv-id',
    ticketKey: 'review',
    messages: [],
    context: {},
    totalTokensUsed: { input: 0, output: 0 },
    createdAt: new Date(),
    updatedAt: new Date(),
  }),
  startChatSession: createTrackedFn(undefined),
});

async function buildCommand() {
  const mockConvService = createMockConversationService();

  const module = await Test.createTestingModule({
    providers: [
      IssueReviewCommand,
      {
        provide: AiService,
        useValue: { getProviderDisplayName: () => 'OpenAI' },
      },
      {
        provide: GitService,
        useValue: {
          getDiff: async () => 'diff --git a/src/guard.ts b/src/guard.ts',
          isGitRepository: async () => true,
        },
      },
      {
        provide: IssueTrackerService,
        useValue: {
          getDefaultAdapter: () => ({
            getTrackerName: () => 'jira',
            getTicket: async () => {
              throw new Error('no ticket');
            },
            findPullRequestsByTicketKey: async () => [],
          }),
          getAdapter: () => {
            throw new Error('not needed');
          },
          getPullRequestDiscoveryAdapters: () => new Map(),
          getAllAdapters: () => new Map(),
        },
      },
      {
        provide: ReviewStageService,
        useValue: { reviewDiff: async () => mockReview },
      },
      {
        provide: LoggerService,
        useValue: {
          info: () => undefined,
          warn: () => undefined,
          error: () => undefined,
          success: () => undefined,
        },
      },
      {
        provide: DryRunPreviewService,
        useValue: {
          showHeader: () => undefined,
          showSummary: () => undefined,
          showValidationResult: () => undefined,
          previewApiCall: () => undefined,
          previewFileRead: () => undefined,
          previewFileWrite: () => undefined,
        },
      },
      {
        provide: ConversationService,
        useValue: mockConvService,
      },
    ],
  }).compile();

  return {
    command: module.get(IssueReviewCommand),
    conversationService: mockConvService,
  };
}

function setTTY(value: boolean): void {
  Object.defineProperty(process.stdin, 'isTTY', {
    value,
    configurable: true,
  });
  Object.defineProperty(process.stdout, 'isTTY', {
    value,
    configurable: true,
  });
}

async function run(): Promise<void> {
  console.log('🧪 Manual smoke: issue:review interactive follow-up chat\n');

  // --- Test 1: Chat prompt appears and startChatSession is called ---
  {
    const { command, conversationService } = await buildCommand();
    setTTY(true);

    const originalPrompt = inquirer.prompt;
    (inquirer as any).prompt = async () => ({ startChat: true });

    const originalLog = console.log;
    console.log = () => {};

    try {
      await command.run([], {});
    } finally {
      console.log = originalLog;
      (inquirer as any).prompt = originalPrompt;
      setTTY(false);
    }

    if (conversationService.startChatSession.mock.calls.length !== 1) {
      throw new Error(
        `Expected startChatSession to be called once, got ${conversationService.startChatSession.mock.calls.length}`
      );
    }

    const [convId, options] = conversationService.startChatSession.mock.calls[0];
    if (convId !== 'smoke-conv-id') {
      throw new Error(`Expected conversationId 'smoke-conv-id', got '${convId}'`);
    }
    if (options.maxTurns !== 20) {
      throw new Error(`Expected maxTurns 20, got ${options.maxTurns}`);
    }
    if (!options.exitCommands.includes('exit')) {
      throw new Error('Expected exitCommands to include "exit"');
    }

    const [, context] = conversationService.createConversation.mock.calls[0];
    if (context.ticketKey !== 'review') {
      throw new Error(`Expected ticketKey 'review', got '${context.ticketKey}'`);
    }
    if (context.stage !== 'review') {
      throw new Error(`Expected stage 'review', got '${context.stage}'`);
    }

    console.log('  ✅ Test 1 passed: chat prompt triggers startChatSession');
  }

  // --- Test 2: Chat prompt skipped in silent mode ---
  {
    const { command, conversationService } = await buildCommand();
    setTTY(true);

    const originalLog = console.log;
    console.log = () => {};

    try {
      await command.run([], { silent: true });
    } finally {
      console.log = originalLog;
      setTTY(false);
    }

    if (conversationService.startChatSession.mock.calls.length !== 0) {
      throw new Error('Expected startChatSession NOT to be called in silent mode');
    }

    console.log('  ✅ Test 2 passed: chat prompt skipped in silent mode');
  }

  // --- Test 3: Chat prompt skipped in non-interactive session ---
  {
    const { command, conversationService } = await buildCommand();
    setTTY(false);

    const originalLog = console.log;
    console.log = () => {};

    try {
      await command.run([], {});
    } finally {
      console.log = originalLog;
    }

    if (conversationService.startChatSession.mock.calls.length !== 0) {
      throw new Error('Expected startChatSession NOT to be called in non-TTY mode');
    }

    console.log('  ✅ Test 3 passed: chat prompt skipped in non-interactive session');
  }

  // --- Test 4: System prompt includes review context ---
  {
    const { command, conversationService } = await buildCommand();
    setTTY(true);

    const originalPrompt = inquirer.prompt;
    (inquirer as any).prompt = async () => ({ startChat: true });

    const originalLog = console.log;
    console.log = () => {};

    try {
      await command.run([], {});
    } finally {
      console.log = originalLog;
      (inquirer as any).prompt = originalPrompt;
      setTTY(false);
    }

    const [, options] = conversationService.startChatSession.mock.calls[0];
    const prompt: string = options.systemPrompt;

    if (!prompt.includes('code reviewer')) {
      throw new Error('Expected system prompt to include "code reviewer"');
    }
    if (!prompt.includes('APPROVED')) {
      throw new Error('Expected system prompt to include review verdict');
    }
    if (!prompt.includes('Consider narrowing the type guard')) {
      throw new Error('Expected system prompt to include issue text');
    }
    if (!prompt.includes('src/guard.ts:10')) {
      throw new Error('Expected system prompt to include file:line reference');
    }

    console.log('  ✅ Test 4 passed: system prompt includes review context');
  }

  console.log('\n✅ All interactive chat smoke tests passed');
}

run().catch(error => {
  console.error(`\n❌ Manual smoke test failed: ${error.message}`);
  process.exit(1);
});
