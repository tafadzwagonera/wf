/**
 * Manual smoke test for the Proportionality review guideline and
 * human-friendly suggestion tone in issue:review output.
 *
 * Verifies:
 * 1. The default review guidelines include "Proportionality"
 * 2. Suggestions rendered in terminal and PR comments are present and concise
 * 3. The smallest-effective-fix criterion surfaces in review output
 *
 * Run:
 *   yarn test:manual -- test-issue-review-proportionality
 */

import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { AiService } from '../../src/integrations/ai/ai.service';
import { ReviewStageService } from '../../src/workflows/stages/review-stage.service';
import { StageAgentService } from '../../src/integrations/ai/stage-agent.service';
import { IssueReviewCommand } from '../../src/commands/issue-review.command';
import { GitService } from '../../src/integrations/git/git.service';
import { PlatformService } from '../../src/integrations/platforms/platform.service';
import { LoggerService } from '../../src/shared/logger/logger.service';
import { DryRunPreviewService } from '../../src/shared/preview/dry-run-preview.service';

const mockReview = {
  summary: 'Adds a helper utility where a one-liner suffices',
  issues: [
    {
      severity: 'warning' as const,
      message: 'Over-engineered: new abstraction wraps a single call',
      file: 'src/utils/wrap.ts',
      line: 5,
      suggestion:
        'Inline the call at the usage site instead of adding a wrapper',
    },
  ],
  suggestions: ['Remove the unused helper and call the function directly'],
  approved: false,
  traceProvenance: 'best-effort' as const,
  callStack: [],
  stateTransition: {},
};

async function run(): Promise<void> {
  console.log(
    '🧪 Manual smoke: issue:review proportionality + human-friendly suggestions\n',
  );

  // ── Part 1: ReviewStageService passes "Proportionality" guideline ──

  let capturedGuidelines: string[] = [];

  const stageModule = await Test.createTestingModule({
    providers: [
      ReviewStageService,
      {
        provide: ConfigService,
        useValue: {
          get: (_key: string, fallback?: unknown) => fallback,
        },
      },
      {
        provide: AiService,
        useValue: {
          reviewCode: async (_diff: string, guidelines: string[]) => {
            capturedGuidelines = guidelines;
            return mockReview;
          },
        },
      },
      {
        provide: StageAgentService,
        useValue: {
          isEnabledForStage: () => false,
        },
      },
    ],
  }).compile();

  const reviewStageService = stageModule.get(ReviewStageService);
  await reviewStageService.reviewDiff('diff --git a/file b/file', {
    context: 'ticket TEST-1: Proportionality check',
  });

  const hasProportionality = capturedGuidelines.some((g) =>
    g.includes('Proportionality'),
  );
  if (!hasProportionality) {
    throw new Error(
      'Expected "Proportionality" to appear in the default review guidelines passed to the AI.',
    );
  }

  const hasSimplestEffective = capturedGuidelines.some((g) =>
    g.includes('simplest effective implementation'),
  );
  if (!hasSimplestEffective) {
    throw new Error(
      'Expected "simplest effective implementation" phrasing in the Simplicity guideline.',
    );
  }

  console.log('  ✅ Part 1: Proportionality guideline is present in defaults');

  // ── Part 2: Terminal output renders suggestion text ──

  const createdComments: Array<{ ref: string; body: string }> = [];
  const getPullRequestDiff = async (): Promise<string> =>
    'diff --git a/src/utils/wrap.ts b/src/utils/wrap.ts';
  const getAdapter = (platformName: string) => {
    if (platformName !== 'bitbucket') {
      throw new Error(`Unknown platform: ${platformName}`);
    }
    return {
      getPlatformName: () => 'bitbucket',
      createComment: async (ref: string, body: string) => {
        createdComments.push({ ref, body });
      },
      createInlineComment: async () => undefined,
      getPullRequestDiff,
    };
  };

  const commandModule = await Test.createTestingModule({
    providers: [
      IssueReviewCommand,
      {
        provide: AiService,
        useValue: { getProviderDisplayName: () => 'Anthropic Claude' },
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
          getDefaultAdapter: () => getAdapter('bitbucket'),
          getAdapter,
          getPullRequestDiscoveryAdapters: () => new Map(),
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
    ],
  }).compile();

  const command = commandModule.get(IssueReviewCommand);
  const originalConsoleLog = console.log;
  let capturedLogs = '';

  console.log = (...args: unknown[]) => {
    capturedLogs += `${args.map(String).join(' ')}\n`;
  };

  await command.run(
    ['https://bitbucket.org/workspace/repo/pull-requests/200'],
    { comment: true },
  );

  console.log = originalConsoleLog;

  if (
    !capturedLogs.includes(
      'Over-engineered: new abstraction wraps a single call',
    )
  ) {
    throw new Error(
      'Expected proportionality issue message in terminal output.',
    );
  }

  if (
    !capturedLogs.includes(
      'Suggestion: Inline the call at the usage site instead of adding a wrapper',
    )
  ) {
    throw new Error(
      'Expected human-friendly suggestion text in terminal output.',
    );
  }

  if (
    !capturedLogs.includes(
      'Remove the unused helper and call the function directly',
    )
  ) {
    throw new Error(
      'Expected trailing suggestion about smallest effective fix in terminal output.',
    );
  }

  console.log('  ✅ Part 2: Terminal output renders proportionality feedback');

  // ── Part 3: PR comment includes suggestion text ──

  const summaryComment = createdComments.find((c) =>
    c.ref.includes('pull-requests/200'),
  );
  if (!summaryComment) {
    throw new Error('Expected a PR summary comment to be posted.');
  }

  if (
    !summaryComment.body.includes(
      'Suggestion: Inline the call at the usage site instead of adding a wrapper',
    )
  ) {
    throw new Error(
      'Expected human-friendly issue-local suggestion in the PR comment body.',
    );
  }

  if (
    !summaryComment.body.includes(
      'Remove the unused helper and call the function directly',
    )
  ) {
    throw new Error('Expected trailing suggestion in the PR comment body.');
  }

  console.log('  ✅ Part 3: PR comment includes human-friendly suggestions');

  console.log(
    '\n✅ Manual smoke test passed: issue:review proportionality + suggestions',
  );
}

run().catch((error) => {
  console.error(`❌ Manual smoke test failed: ${error.message}`);
  process.exit(1);
});
