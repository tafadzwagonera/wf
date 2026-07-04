/**
 * Manual smoke tests for ticket-keyed issue:review cache artifacts.
 *
 * Run:
 *   nr test:manual -- test-issue-review-cache-artifact
 */

import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import * as fs from 'fs';
import * as path from 'path';
import { IssueReviewCommand } from '../../src/commands/issue-review.command';
import { AiService } from '../../src/integrations/ai/ai.service';
import { GitService } from '../../src/integrations/git/git.service';
import { IssueTrackerService } from '../../src/integrations/issue-trackers/issue-tracker.service';
import { LoggerService } from '../../src/shared/logger/logger.service';
import { DryRunPreviewService } from '../../src/shared/preview/dry-run-preview.service';
import { ReviewStageService } from '../../src/workflows/stages/review-stage.service';
import { ConversationService } from '../../src/integrations/ai/conversation/conversation.service';

const createModule = async () => {
  const jiraAdapter = {
    getTrackerName: () => 'jira',
    getTicket: async () => {
      throw new Error('ticket lookup should be skipped');
    },
    findPullRequestsByTicketKey: async () => [],
    getPullRequestDiff: async () => '',
  };

  return Test.createTestingModule({
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
        useValue: {
          get: (_key: string, defaultValue?: string) => defaultValue,
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
        provide: IssueTrackerService,
        useValue: {
          getDefaultAdapter: () => jiraAdapter,
          getAdapter: () => jiraAdapter,
          getPullRequestDiscoveryAdapters: () => new Map(),
        },
      },
      {
        provide: ReviewStageService,
        useValue: {
          reviewDiff: async () => {
            throw new Error('reviewDiff should not run on cache hit');
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
          showSkipped: () => undefined,
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
};

async function run(): Promise<void> {
  console.log('🧪 Manual smoke: issue:review cache artifact behavior\n');

  const module = await createModule();
  const command = module.get(IssueReviewCommand);
  const mockCachedReviewPath = (command as any).resolveTicketReviewArtifactPath(
    'TAD-575',
    ['service-tourv3'],
    'jira'
  ) as string;
  const mockSilentOutputPath = (command as any).resolveOutputPath(
    'review.txt',
    (command as any).resolveOutputBaseDir('TAD-575', ['service-tourv3'])
  ) as string;

  fs.mkdirSync(path.dirname(mockCachedReviewPath), { recursive: true });
  fs.writeFileSync(mockCachedReviewPath, '# Cached review\n\nAlready reviewed.');

  let capturedLogs: string[] = [];
  const originalConsoleLog = console.log;
  console.log = (...args: unknown[]) => {
    capturedLogs.push(args.map(String).join(' '));
  };

  try {
    await command.run(['TAD-575'], { repos: ['service-tourv3'] });

    if (!capturedLogs.includes(`  Review artifact exists: ${mockCachedReviewPath}`)) {
      throw new Error('Expected cache-hit notice to be logged for a ticket review.');
    }

    capturedLogs = [];
    await command.run(['TAD-575'], {
      repos: ['service-tourv3'],
      output: 'review.txt',
      silent: true,
    });

    if (capturedLogs.length !== 1 || capturedLogs[0] !== mockSilentOutputPath) {
      throw new Error('Expected silent cached review with --output to print only the output path.');
    }
  } finally {
    console.log = originalConsoleLog;
    if (fs.existsSync(mockCachedReviewPath)) {
      fs.unlinkSync(mockCachedReviewPath);
    }
    if (fs.existsSync(mockSilentOutputPath)) {
      fs.unlinkSync(mockSilentOutputPath);
    }
  }

  console.log('✅ Manual smoke test passed: issue:review cache artifact behavior');
}

run().catch(error => {
  console.error(`❌ Manual smoke test failed: ${error.message}`);
  process.exit(1);
});
