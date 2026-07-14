/**
 * Manual smoke tests for issue:review trace alignment behavior.
 *
 * Run:
 *   yarn test:manual -- test-issue-review-trace-alignment
 */

import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { IssueReviewCommand } from '../../src/commands/issue-review.command';
import { AiService } from '../../src/integrations/ai/ai.service';
import { GitService } from '../../src/integrations/git/git.service';
import { IssueTrackerService } from '../../src/integrations/issue-trackers/issue-tracker.service';
import { LoggerService } from '../../src/shared/logger/logger.service';
import { DryRunPreviewService } from '../../src/shared/preview/dry-run-preview.service';
import { ReviewStageService } from '../../src/workflows/stages/review-stage.service';
import { ConversationService } from '../../src/integrations/ai/conversation/conversation.service';
import * as path from 'path';

type MockAdapter = {
  getPlatformName: () => string;
  getTrackerName: () => string;
  getTicket: () => Promise<{ key: string; title: string; description: string }>;
  findPullRequestsByTicketKey: (ticketKey: string, repoHint?: string) => Promise<string[]>;
  getPullRequestDiff: (url: string) => Promise<string>;
};

const buildAdapter = (name: string): MockAdapter => ({
  getPlatformName: () => name,
  getTrackerName: () => name,
  getTicket: async () => ({
    key: 'TAD-575',
    title: 'Test ticket',
    description: 'Ticket description',
  }),
  findPullRequestsByTicketKey: async () => [],
  getPullRequestDiff: async () => '',
});

const setNonInteractiveSession = (): void => {
  Object.defineProperty(process.stdin, 'isTTY', {
    value: false,
    configurable: true,
  });
  Object.defineProperty(process.stdout, 'isTTY', {
    value: false,
    configurable: true,
  });
};

const mockReview = {
  summary: 'Looks good overall',
  issues: [],
  suggestions: [],
  approved: true,
  traceProvenance: 'best-effort',
  callStack: [
    {
      frame: 'Service.entry()',
      children: [{ frame: 'Service.child()' }],
    },
  ],
  stateTransition: {
    from: 'A',
    to: 'B',
    steps: [{ frame: 'Service.entry()', changes: { state: { after: 'B' } } }],
  },
};

async function run(): Promise<void> {
  console.log('🧪 Manual smoke: issue:review trace alignment\n');

  const jiraAdapter: MockAdapter = buildAdapter('jira');
  const githubAdapter: MockAdapter = buildAdapter('github');
  const bitbucketAdapter: MockAdapter = buildAdapter('bitbucket');
  const repoName = path.basename(process.cwd());
  const prUrl = 'https://bitbucket.org/workspace/repo/pull-requests/160';
  const repoDir = path.resolve(process.cwd(), '..', repoName);

  const reviewDiffCalls: Array<{ repoDir?: string }> = [];
  let capturedLogs = '';

  bitbucketAdapter.findPullRequestsByTicketKey = async () => [prUrl];
  bitbucketAdapter.getPullRequestDiff = async () => 'diff 160';

  const module = await Test.createTestingModule({
    providers: [
      IssueReviewCommand,
      {
        provide: AiService,
        useValue: {
          getProviderDisplayName: () => 'OpenAI',
        },
      },
      {
        provide: ConfigService,
        useValue: { get: (_key: string, fallback?: unknown) => fallback },
      },
      {
        provide: GitService,
        useValue: {
          getDiff: async () => '',
          isGitRepository: async () => true,
        },
      },
      {
        provide: IssueTrackerService,
        useValue: {
          getDefaultAdapter: () => jiraAdapter,
          getAdapter: (trackerName: string) => {
            if (trackerName === 'jira') return jiraAdapter;
            if (trackerName === 'github') return githubAdapter;
            if (trackerName === 'bitbucket') return bitbucketAdapter;
            throw new Error(`Unknown platform: ${trackerName}`);
          },
          getPullRequestDiscoveryAdapters: () =>
            new Map([
              ['bitbucket', bitbucketAdapter],
              ['github', githubAdapter],
            ]),
        },
      },
      {
        provide: ReviewStageService,
        useValue: {
          reviewDiff: async (_diff: string, options: { repoDir?: string }) => {
            reviewDiffCalls.push({ repoDir: options.repoDir });
            return mockReview;
          },
        },
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
        useValue: {
          loadConversation: async () => null,
          createConversation: async () => ({ conversationId: 'mock' }),
          startChatSession: async () => undefined,
        },
      },
    ],
  }).compile();

  const command = module.get(IssueReviewCommand);

  const originalConsoleLog = console.log;
  const originalBitbucketFind = bitbucketAdapter.findPullRequestsByTicketKey;
  const bitbucketCalls: Array<string | undefined> = [];
  bitbucketAdapter.findPullRequestsByTicketKey = async (ticketKey: string, repoHint?: string) => {
    void ticketKey;
    bitbucketCalls.push(repoHint);
    return originalBitbucketFind(ticketKey, repoHint);
  };
  console.log = (...args: unknown[]) => {
    capturedLogs += `${args.map(String).join(' ')}\n`;
  };

  setNonInteractiveSession();
  await command.run([], { ticketKey: 'TAD-575', force: true });
  await command.run([], { ticketKey: 'TAD-575', repos: [repoName], force: true });

  console.log = originalConsoleLog;

  if (bitbucketCalls[0] !== repoName) {
    throw new Error(`Expected default discovery repo hint "${repoName}", received "${bitbucketCalls[0]}"`);
  }

  if (reviewDiffCalls.length < 2) {
    throw new Error(`Expected at least 2 reviewDiff calls, received ${reviewDiffCalls.length}`);
  }

  if (reviewDiffCalls[0].repoDir !== repoDir) {
    throw new Error(`Expected inferred run repoDir "${repoDir}", received "${reviewDiffCalls[0].repoDir}"`);
  }

  if (reviewDiffCalls[1].repoDir !== repoDir) {
    throw new Error(`Expected explicit run repoDir "${repoDir}", received "${reviewDiffCalls[1].repoDir}"`);
  }

  if (!capturedLogs.includes('Call Stack:') || !capturedLogs.includes('└─')) {
    throw new Error('Expected nested Call Stack output with tree branches from ebfc4612 renderer.');
  }

  if (!capturedLogs.includes('State Transition:') || !capturedLogs.includes('from: A')) {
    throw new Error('Expected State Transition output to include nested trace content.');
  }

  console.log('✅ Manual smoke test passed: issue:review trace alignment');
}

run().catch(error => {
  console.error(`❌ Manual smoke test failed: ${error.message}`);
  process.exit(1);
});
