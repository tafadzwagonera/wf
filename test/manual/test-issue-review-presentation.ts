/**
 * Manual smoke tests for issue:review presentation and inline comment output.
 *
 * Run:
 *   yarn test:manual -- test-issue-review-presentation
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

const mockReview = {
  summary: 'Review summary',
  issues: [
    {
      severity: 'warning' as const,
      message: 'Use a narrower guard',
      file: 'src/example.ts',
      line: 24,
      suggestion: 'Add a focused regression test',
    },
    {
      severity: 'info' as const,
      message: 'Rename the helper',
      file: 'src/example.ts',
      line: undefined,
      suggestion: 'Use a domain-specific helper name',
    },
  ],
  suggestions: ['Consider documenting the fallback behavior'],
  approved: false,
  traceProvenance: 'best-effort' as const,
  callStack: [],
  stateTransition: {},
};

async function run(): Promise<void> {
  console.log('🧪 Manual smoke: issue:review presentation\n');

  const createdComments: Array<{ ref: string; body: string }> = [];
  const createdInlineComments: Array<{
    ref: string;
    file: string;
    line: number;
    body: string;
  }> = [];
  const createComment = async (ref: string, body: string): Promise<void> => {
    createdComments.push({ ref, body });
  };
  const createInlineComment = async (ref: string, file: string, line: number, body: string): Promise<void> => {
    createdInlineComments.push({ ref, file, line, body });
  };
  const getPullRequestDiff = async (): Promise<string> => 'diff --git a/src/example.ts b/src/example.ts';
  const getAdapter = (trackerName: string) => {
    if (trackerName !== 'bitbucket') {
      throw new Error(`Unknown platform: ${trackerName}`);
    }

    return {
      getPlatformName: () => 'bitbucket',
      createComment,
      createInlineComment,
      getPullRequestDiff,
    };
  };

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
          getDefaultAdapter: () => getAdapter('bitbucket'),
          getAdapter,
          getPullRequestDiscoveryAdapters: () => new Map(),
        },
      },
      {
        provide: ReviewStageService,
        useValue: {
          reviewDiff: async () => mockReview,
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
  let capturedLogs = '';

  console.log = (...args: unknown[]) => {
    capturedLogs += `${args.map(String).join(' ')}\n`;
  };

  await command.run(['https://bitbucket.org/workspace/repo/pull-requests/160'], { comment: true });

  console.log = originalConsoleLog;

  if (
    !capturedLogs.includes('[WARNING] Use a narrower guard')
    || !capturedLogs.includes('Suggestion: Add a focused regression test')
  ) {
    throw new Error('Expected issue-local suggestion output in the terminal renderer.');
  }

  if (!capturedLogs.includes('💡 Consider documenting the fallback behavior')) {
    throw new Error('Expected unmatched trailing suggestions in the terminal renderer.');
  }

  if (
    !capturedLogs.includes('[INFO] Rename the helper')
    || !capturedLogs.includes('Suggestion: Use a domain-specific helper name')
  ) {
    throw new Error('Expected later issue rows to preserve suggestion adjacency.');
  }

  const summaryComment = createdComments.find(
    comment => comment.ref === 'https://bitbucket.org/workspace/repo/pull-requests/160'
  );
  if (
    !summaryComment?.body.includes(
      '- [warning] Use a narrower guard (src/example.ts:24)\n  Suggestion: Add a focused regression test'
    )
  ) {
    throw new Error('Expected PR summary comment to keep paired suggestions beside their issues.');
  }

  if (!summaryComment.body.includes('### Suggestions\n- Consider documenting the fallback behavior')) {
    throw new Error('Expected PR summary comment to keep unmatched suggestions in a trailing section.');
  }

  const inlineComment = createdInlineComments.find(
    comment =>
      comment.ref === 'https://bitbucket.org/workspace/repo/pull-requests/160'
      && comment.file === 'src/example.ts'
      && comment.line === 24
      && comment.body === 'Use a narrower guard'
  );
  if (!inlineComment) {
    throw new Error('Expected an inline comment to be posted with the normalized destination-side line.');
  }

  console.log('✅ Manual smoke test passed: issue:review presentation');
}

run().catch(error => {
  console.error(`❌ Manual smoke test failed: ${error.message}`);
  process.exit(1);
});
