/**
 * Manual smoke tests for legacy detached issue:review suggestions.
 *
 * Run:
 *   yarn test:manual -- test-issue-review-legacy-suggestions
 */

import { Test } from '@nestjs/testing';
import { IssueReviewCommand } from '../../src/commands/issue-review.command';
import { AiService } from '../../src/integrations/ai/ai.service';
import { GitService } from '../../src/integrations/git/git.service';
import { PlatformService } from '../../src/integrations/platforms/platform.service';
import { LoggerService } from '../../src/shared/logger/logger.service';
import { DryRunPreviewService } from '../../src/shared/preview/dry-run-preview.service';
import { ReviewStageService } from '../../src/workflows/stages/review-stage.service';

const mockLegacyReview = {
  summary: 'Review summary',
  issues: [
    {
      severity: 'warning' as const,
      message: 'Duplicate keys are silently accepted.',
      file: 'src/helpers/csv.helper.ts',
      line: 28,
    },
    {
      severity: 'warning' as const,
      message: 'Lookups remain case-sensitive and unnormalized.',
      file: 'src/functions/index.ts',
      line: 114,
    },
  ],
  suggestions: [
    'Normalize lookup inputs before querying.',
    'Add duplicate detection while building the maps.',
  ],
  approved: false,
  traceProvenance: 'best-effort' as const,
  callStack: [],
  stateTransition: {},
};

async function run(): Promise<void> {
  console.log('🧪 Manual smoke: issue:review legacy detached suggestions\n');
  const prUrl = 'https://bitbucket.org/workspace/repo/pull-requests/35';
  const bitbucketAdapter = {
    getPlatformName: () => 'bitbucket',
    getTicket: async () => ({
      key: 'WBP-3087',
      title: 'Cache geo CSV',
      description: 'Ticket description',
    }),
    findPullRequestsByTicketKey: async () => [prUrl],
    getPullRequestDiff: async () =>
      'diff --git a/src/example.ts b/src/example.ts',
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
        provide: GitService,
        useValue: {
          getDiff: async () => '',
          isGitRepository: async () => true,
        },
      },
      {
        provide: PlatformService,
        useValue: {
          getDefaultAdapter: () => bitbucketAdapter,
          getAdapter: () => bitbucketAdapter,
          getPullRequestDiscoveryAdapters: () =>
            new Map([['bitbucket', bitbucketAdapter]]),
        },
      },
      {
        provide: ReviewStageService,
        useValue: {
          reviewDiff: async () => mockLegacyReview,
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
    ],
  }).compile();

  const command = module.get(IssueReviewCommand);
  const originalConsoleLog = console.log;
  let capturedLogs = '';

  console.log = (...args: unknown[]) => {
    capturedLogs += `${args.map(String).join(' ')}\n`;
  };

  await command.run(['WBP-3087'], {});

  console.log = originalConsoleLog;

  if (
    capturedLogs.includes(
      'Suggestion: Normalize lookup inputs before querying.',
    )
  ) {
    throw new Error(
      'Expected detached legacy suggestions to stay out of issue-local renderer rows.',
    );
  }

  if (
    capturedLogs.includes(
      'Suggestion: Add duplicate detection while building the maps.',
    )
  ) {
    throw new Error(
      'Expected detached legacy suggestions to stay out of issue-local renderer rows.',
    );
  }

  if (
    !capturedLogs.includes('Suggestions:') ||
    !capturedLogs.includes('💡 Normalize lookup inputs before querying.') ||
    !capturedLogs.includes(
      '💡 Add duplicate detection while building the maps.',
    )
  ) {
    throw new Error(
      'Expected legacy detached suggestions to render only in the trailing Suggestions section.',
    );
  }

  console.log(
    '✅ Manual smoke test passed: issue:review legacy detached suggestions',
  );
}

run().catch((error) => {
  console.error(`❌ Manual smoke test failed: ${error.message}`);
  process.exit(1);
});
