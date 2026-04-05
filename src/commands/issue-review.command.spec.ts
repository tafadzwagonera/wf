// Mock chalk before any imports
jest.mock('chalk', () => {
  const identity = (s: any) => s;
  const makeChain = () => {
    const chain: any = identity;
    [
      'bold',
      'dim',
      'italic',
      'underline',
      'inverse',
      'strikethrough',
      'black',
      'red',
      'green',
      'yellow',
      'blue',
      'magenta',
      'cyan',
      'white',
      'gray',
      'grey',
    ].forEach((name) => {
      chain[name] = identity;
    });
    return chain;
  };
  const chalk = makeChain();
  chalk.bold = makeChain();
  return { default: chalk, ...chalk };
});

jest.mock('../agents/utils', () => {
  const actual = jest.requireActual('../agents/utils');
  return {
    ...actual,
    resolveRepoBasePath: jest.fn((repo?: string) =>
      repo ? path.join('/mock', repo) : '/mock/repo',
    ),
  };
});

import { Test } from '@nestjs/testing';
import { IssueReviewCommand } from './issue-review.command';
import { AiService } from '../integrations/ai/ai.service';
import { GitService } from '../integrations/git/git.service';
import { PlatformService } from '../integrations/platforms/platform.service';
import { LoggerService } from '../shared/logger/logger.service';
import { DryRunPreviewService } from '../shared/preview/dry-run-preview.service';
import { ReviewStageService } from '../workflows/stages/review-stage.service';
import * as os from 'os';
import * as path from 'path';

const mockTicket = { key: 'TAD-575', summary: 'Test ticket', description: '' };

async function buildCommand(overrides?: {
  findPullRequestByTicketKey?: jest.Mock;
}): Promise<{
  command: IssueReviewCommand;
  reviewStageService: jest.Mocked<ReviewStageService>;
}> {
  const findPullRequestByTicketKey =
    overrides?.findPullRequestByTicketKey ?? jest.fn().mockResolvedValue(null);

  const module = await Test.createTestingModule({
    providers: [
      IssueReviewCommand,
      {
        provide: AiService,
        useValue: {
          getProviderDisplayName: jest.fn().mockReturnValue('OpenAI'),
        },
      },
      {
        provide: GitService,
        useValue: {
          getDiff: jest.fn().mockResolvedValue(''),
          isGitRepository: jest.fn().mockResolvedValue(true),
        },
      },
      {
        provide: PlatformService,
        useValue: {
          getDefaultAdapter: jest.fn().mockReturnValue({
            getTicket: jest.fn().mockResolvedValue(mockTicket),
          }),
          getAdapter: jest.fn().mockReturnValue({
            findPullRequestByTicketKey,
          }),
        },
      },
      {
        provide: ReviewStageService,
        useValue: {
          reviewDiff: jest.fn().mockResolvedValue({
            summary: 'ok',
            issues: [],
            suggestions: [],
            approved: true,
          }),
        },
      },
      {
        provide: LoggerService,
        useValue: {
          info: jest.fn(),
          warn: jest.fn(),
          error: jest.fn(),
          success: jest.fn(),
        },
      },
      {
        provide: DryRunPreviewService,
        useValue: {
          showHeader: jest.fn(),
          showSummary: jest.fn(),
          showValidationResult: jest.fn(),
          previewApiCall: jest.fn(),
          previewFileRead: jest.fn(),
          previewFileWrite: jest.fn(),
        },
      },
    ],
  }).compile();

  return {
    command: module.get(IssueReviewCommand),
    reviewStageService: module.get(ReviewStageService),
  };
}

describe('IssueReviewCommand', () => {
  describe('parseRepos', () => {
    it('returns trimmed repo values from variadic option input', async () => {
      const { command } = await buildCommand();

      expect(
        command.parseRepos([' repo-a ', 'workspace/repo-b', ''] as any),
      ).toEqual(['repo-a', 'workspace/repo-b']);
    });
  });

  describe('ticket key uses local repo review with ticket context', () => {
    it('reviews local changes instead of searching for a PR', async () => {
      const { command, reviewStageService } = await buildCommand();
      const reviewRepoSetSpy = jest
        .spyOn(command as any, 'reviewRepoSet')
        .mockResolvedValue('diff content');

      await command.run(['TAD-575'], { repos: ['service-tourv3'] });

      expect(reviewRepoSetSpy).toHaveBeenCalled();
      expect(reviewStageService.reviewDiff).toHaveBeenCalledWith(
        'diff content',
        expect.objectContaining({
          context: expect.stringContaining('ticket TAD-575'),
        }),
      );
    });
  });

  describe('source validation and repo targeting', () => {
    it('rejects filesystem paths as invalid sources', async () => {
      const { command } = await buildCommand();
      const exitSpy = jest
        .spyOn(process, 'exit')
        .mockImplementation((() => {}) as any);
      const consoleErrorSpy = jest
        .spyOn(console, 'error')
        .mockImplementation(() => {});
      jest.spyOn(require('fs'), 'existsSync').mockReturnValue(true);

      await command.run(['../repo-path'], {});

      expect(exitSpy).toHaveBeenCalledWith(1);
      const errorOutput = consoleErrorSpy.mock.calls
        .map((c) => c.join(' '))
        .join('\n');
      expect(errorOutput).toContain(
        'Expected: ticket key (ABC-123) or PR URL.',
      );

      exitSpy.mockRestore();
      consoleErrorSpy.mockRestore();
    });

    it('reviews each resolved repo when --repos is provided without a source', async () => {
      const { command, reviewStageService } = await buildCommand();
      const reviewCurrentRepoSpy = jest
        .spyOn(command as any, 'reviewCurrentRepo')
        .mockResolvedValueOnce('diff a')
        .mockResolvedValueOnce('diff b');

      await command.run([], { repos: ['repo-a', 'repo-b'] });

      expect(reviewCurrentRepoSpy).toHaveBeenCalledTimes(2);
      expect(reviewCurrentRepoSpy).toHaveBeenNthCalledWith(1, '/mock/repo-a');
      expect(reviewCurrentRepoSpy).toHaveBeenNthCalledWith(2, '/mock/repo-b');
      expect(reviewStageService.reviewDiff).toHaveBeenCalled();
    });
  });

  describe('--output path resolution', () => {
    afterEach(() => {
      jest.restoreAllMocks();
    });

    it('previews a filename-only output under the repo custom namespace in dry-run mode', async () => {
      const { command } = await buildCommand();
      const dryRunPreview = (command as any)
        .dryRunPreview as jest.Mocked<DryRunPreviewService>;

      await command.run([], {
        repos: ['repo-a'],
        output: 'review.md',
        dryRun: true,
      });

      expect(dryRunPreview.previewFileWrite).toHaveBeenCalledWith(
        expect.objectContaining({
          filePath: path.join(os.homedir(), '.wf', 'repo-a', 'review.md'),
        }),
      );
    });

    it('stores a filename-only output under the repo custom namespace', async () => {
      const { command } = await buildCommand();
      const reviewRepoSetSpy = jest
        .spyOn(command as any, 'reviewRepoSet')
        .mockResolvedValue('diff content');
      const writeFileSyncSpy = jest
        .spyOn(require('fs'), 'writeFileSync')
        .mockImplementation(() => {});

      await command.run([], { repos: ['repo-a'], output: 'review.md' });

      expect(reviewRepoSetSpy).toHaveBeenCalled();
      expect(writeFileSyncSpy).toHaveBeenCalledWith(
        path.join(os.homedir(), '.wf', 'repo-a', 'review.md'),
        expect.any(String),
      );
    });

    it('keeps explicit relative output paths in the filesystem namespace', async () => {
      const { command } = await buildCommand();
      const reviewRepoSetSpy = jest
        .spyOn(command as any, 'reviewRepoSet')
        .mockResolvedValue('diff content');
      const writeFileSyncSpy = jest
        .spyOn(require('fs'), 'writeFileSync')
        .mockImplementation(() => {});

      await command.run([], { repos: ['repo-a'], output: 'reports/review.md' });

      expect(reviewRepoSetSpy).toHaveBeenCalled();
      expect(writeFileSyncSpy).toHaveBeenCalledWith(
        path.resolve('reports/review.md'),
        expect.any(String),
      );
    });
  });
});
