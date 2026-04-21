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
      'blueBright',
      'magenta',
      'cyan',
      'white',
      'whiteBright',
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

jest.mock('inquirer', () => ({
  __esModule: true,
  default: {
    prompt: jest.fn(),
  },
}));

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
import inquirer from 'inquirer';
import { IssueReviewCommand } from './issue-review.command';
import { AiService, CodeReview } from '../integrations/ai/ai.service';
import { GitService } from '../integrations/git/git.service';
import { PlatformService } from '../integrations/platforms/platform.service';
import { LoggerService } from '../shared/logger/logger.service';
import { DryRunPreviewService } from '../shared/preview/dry-run-preview.service';
import { ReviewStageService } from '../workflows/stages/review-stage.service';
import { ErrorHandler } from '../shared/utils/error-handler';
import * as os from 'os';
import * as path from 'path';

const mockTicket = {
  key: 'TAD-575',
  title: 'Test ticket',
  description: 'Ticket description',
};

const mockReview: CodeReview = {
  summary: 'Looks good overall',
  issues: [
    {
      severity: 'warning',
      message: 'Consider splitting the helper',
      file: 'src/auth.ts',
      line: 12,
    },
  ],
  traceProvenance: 'best-effort',
  callStack: ['ticket lookup', 'PR discovery', 'diff review'],
  stateTransition: {
    from: 'ticket-resolved',
    to: 'reviewed',
    steps: [
      { state: 'ticket-resolved', next: 'pull-requests-found' },
      { state: 'pull-requests-found', next: 'reviewed' },
    ],
  },
  suggestions: ['Add a regression test'],
  approved: true,
};

const buildAdapter = (name: string, defaults: Record<string, any> = {}) => ({
  getPlatformName: jest.fn().mockReturnValue(name),
  getTicket: jest.fn(),
  findPullRequestsByTicketKey: jest.fn().mockResolvedValue([]),
  getPullRequestDiff: jest.fn().mockResolvedValue(''),
  createComment: jest.fn().mockResolvedValue(undefined),
  createInlineComment: jest.fn().mockResolvedValue(undefined),
  ...defaults,
});

const setInteractiveSession = (): void => {
  Object.defineProperty(process.stdin, 'isTTY', {
    value: true,
    configurable: true,
  });
  Object.defineProperty(process.stdout, 'isTTY', {
    value: true,
    configurable: true,
  });
};

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

async function buildCommand(overrides?: {
  ticketAdapterName?: 'jira' | 'github' | 'bitbucket';
}): Promise<{
  command: IssueReviewCommand;
  reviewStageService: jest.Mocked<ReviewStageService>;
  adapters: Record<string, any>;
  promptMock: jest.MockedFunction<typeof inquirer.prompt>;
}> {
  const jiraAdapter = buildAdapter(
    'jira',
    overrides?.ticketAdapterName === 'jira'
      ? { getTicket: jest.fn().mockResolvedValue(mockTicket) }
      : {
          getTicket: jest
            .fn()
            .mockRejectedValue(new Error('Unexpected ticket lookup')),
        },
  );
  const githubAdapter = buildAdapter('github');
  const bitbucketAdapter = buildAdapter('bitbucket');

  if (overrides?.ticketAdapterName === 'github') {
    githubAdapter.getTicket = jest.fn().mockResolvedValue(mockTicket);
  }
  if (overrides?.ticketAdapterName === 'bitbucket') {
    bitbucketAdapter.getTicket = jest.fn().mockResolvedValue(mockTicket);
  }
  if (!overrides?.ticketAdapterName) {
    jiraAdapter.getTicket = jest.fn().mockResolvedValue(mockTicket);
  }

  const promptMock = inquirer.prompt as jest.MockedFunction<
    typeof inquirer.prompt
  >;
  promptMock.mockReset();

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
          getDefaultAdapter: jest.fn().mockReturnValue(jiraAdapter),
          getAdapter: jest.fn((platformName: string) => {
            if (platformName === 'jira') return jiraAdapter;
            if (platformName === 'github') return githubAdapter;
            if (platformName === 'bitbucket') return bitbucketAdapter;
            throw new Error(`Unknown platform: ${platformName}`);
          }),
          getPullRequestDiscoveryAdapters: jest.fn().mockReturnValue(
            new Map([
              ['bitbucket', bitbucketAdapter],
              ['github', githubAdapter],
            ]),
          ),
          getAllAdapters: jest.fn().mockReturnValue(
            new Map([
              ['bitbucket', bitbucketAdapter],
              ['github', githubAdapter],
              ['jira', jiraAdapter],
            ]),
          ),
        },
      },
      {
        provide: ReviewStageService,
        useValue: {
          reviewDiff: jest.fn().mockResolvedValue(mockReview),
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
    adapters: {
      jiraAdapter,
      githubAdapter,
      bitbucketAdapter,
    },
    promptMock,
  };
}

describe('IssueReviewCommand', () => {
  afterEach(() => {
    setNonInteractiveSession();
    jest.restoreAllMocks();
    jest.clearAllMocks();
  });

  describe('parseRepos', () => {
    it('returns trimmed repo values from variadic option input', async () => {
      const { command } = await buildCommand();

      expect(
        command.parseRepos([' repo-a ', 'workspace/repo-b', ''] as any),
      ).toEqual(['repo-a', 'workspace/repo-b']);
    });
  });

  describe('ticket-driven review', () => {
    it('reviews open pull request diffs instead of local changes when PRs are discovered', async () => {
      const { command, reviewStageService, adapters } = await buildCommand();
      const reviewRepoSetSpy = jest
        .spyOn(command as any, 'reviewRepoSet')
        .mockResolvedValue('local diff');

      adapters.bitbucketAdapter.findPullRequestsByTicketKey.mockResolvedValue([
        'https://bitbucket.org/workspace/repo/pull-requests/161',
        'https://bitbucket.org/workspace/repo/pull-requests/160',
      ]);
      adapters.bitbucketAdapter.getPullRequestDiff.mockImplementation(
        async (url: string) => (url.includes('/160') ? 'diff 160' : 'diff 161'),
      );

      await command.run(['TAD-575'], { repos: ['service-tourv3'] });

      expect(reviewRepoSetSpy).not.toHaveBeenCalled();
      expect(reviewStageService.reviewDiff).toHaveBeenNthCalledWith(
        1,
        'diff 160',
        expect.objectContaining({
          context: expect.stringContaining('ticket TAD-575'),
        }),
      );
      expect(reviewStageService.reviewDiff).toHaveBeenNthCalledWith(
        2,
        'diff 161',
        expect.objectContaining({
          context: expect.stringContaining(
            'pull request: https://bitbucket.org/workspace/repo/pull-requests/161',
          ),
        }),
      );
    });

    it('fails hard when ticket lookup does not succeed', async () => {
      const { command, adapters } = await buildCommand();
      const handleSpy = jest
        .spyOn(ErrorHandler, 'handle')
        .mockImplementation(() => undefined as never);

      adapters.jiraAdapter.getTicket.mockRejectedValue(new Error('boom'));

      await command.run(['TAD-575'], {});

      expect(handleSpy).toHaveBeenCalledWith(
        expect.objectContaining({ message: 'boom' }),
      );
    });

    it('prompts for local review when no pull request is found', async () => {
      const { command, reviewStageService, adapters, promptMock } =
        await buildCommand();
      const reviewRepoSetSpy = jest
        .spyOn(command as any, 'reviewRepoSet')
        .mockResolvedValue('local diff');

      adapters.bitbucketAdapter.findPullRequestsByTicketKey.mockResolvedValue(
        [],
      );
      adapters.githubAdapter.findPullRequestsByTicketKey.mockResolvedValue([]);
      promptMock.mockResolvedValue({ decision: 'local' } as any);
      setInteractiveSession();

      await command.run(['TAD-575'], { repos: ['service-tourv3'] });

      expect(promptMock).toHaveBeenCalled();
      expect(reviewRepoSetSpy).toHaveBeenCalled();
      expect(reviewStageService.reviewDiff).toHaveBeenCalledWith(
        'local diff',
        expect.objectContaining({
          context: expect.stringContaining('repositories under review'),
        }),
      );
    });

    it('fans out only across credentialed pull-request discovery adapters', async () => {
      const { command, reviewStageService, adapters, promptMock } =
        await buildCommand();
      const reviewRepoSetSpy = jest
        .spyOn(command as any, 'reviewRepoSet')
        .mockResolvedValue('local diff');
      const consoleLogSpy = jest.spyOn(console, 'log').mockImplementation();

      adapters.bitbucketAdapter.findPullRequestsByTicketKey.mockResolvedValue(
        [],
      );
      promptMock.mockResolvedValue({ decision: 'local' } as any);
      setInteractiveSession();

      await command.run(['TAD-575'], { repos: ['service-tourv3'] });

      expect(reviewRepoSetSpy).toHaveBeenCalled();
      expect(
        adapters.githubAdapter.findPullRequestsByTicketKey,
      ).toHaveBeenCalled();
      expect(reviewStageService.reviewDiff).toHaveBeenCalledWith(
        'local diff',
        expect.objectContaining({
          context: expect.stringContaining('repositories under review'),
        }),
      );
      expect(consoleLogSpy).not.toHaveBeenCalledWith(
        expect.stringContaining('PR discovery skipped for github'),
      );
    });

    it('returns without reviewing when the fallback prompt selects return', async () => {
      const { command, reviewStageService, adapters, promptMock } =
        await buildCommand();
      const reviewRepoSetSpy = jest.spyOn(command as any, 'reviewRepoSet');

      adapters.bitbucketAdapter.findPullRequestsByTicketKey.mockResolvedValue(
        [],
      );
      adapters.githubAdapter.findPullRequestsByTicketKey.mockResolvedValue([]);
      promptMock.mockResolvedValue({ decision: 'return' } as any);
      setInteractiveSession();

      await command.run(['TAD-575'], { repos: ['service-tourv3'] });

      expect(promptMock).toHaveBeenCalled();
      expect(reviewRepoSetSpy).not.toHaveBeenCalled();
      expect(reviewStageService.reviewDiff).not.toHaveBeenCalled();
    });

    it('posts comments to each reviewed pull request', async () => {
      const { command, adapters } = await buildCommand();

      adapters.bitbucketAdapter.findPullRequestsByTicketKey.mockResolvedValue([
        'https://bitbucket.org/workspace/repo/pull-requests/161',
        'https://bitbucket.org/workspace/repo/pull-requests/160',
      ]);
      adapters.bitbucketAdapter.getPullRequestDiff.mockImplementation(
        async (url: string) => (url.includes('/160') ? 'diff 160' : 'diff 161'),
      );

      await command.run(['TAD-575'], {
        repos: ['service-tourv3'],
        comment: true,
      });

      expect(adapters.bitbucketAdapter.createComment).toHaveBeenCalledTimes(2);
      expect(adapters.bitbucketAdapter.createComment).toHaveBeenNthCalledWith(
        1,
        'https://bitbucket.org/workspace/repo/pull-requests/160',
        expect.stringContaining('## AI Code Review'),
      );
      expect(adapters.bitbucketAdapter.createComment).toHaveBeenNthCalledWith(
        2,
        'https://bitbucket.org/workspace/repo/pull-requests/161',
        expect.stringContaining('## AI Code Review'),
      );
    });
  });

  describe('saved output', () => {
    it('writes the new review sections in the expected order', async () => {
      const { command } = await buildCommand();
      const reviewRepoSetSpy = jest
        .spyOn(command as any, 'reviewRepoSet')
        .mockResolvedValue('diff content');
      const writeFileSyncSpy = jest
        .spyOn(require('fs'), 'writeFileSync')
        .mockImplementation(() => {});

      await command.run([], { output: 'review.txt' });

      expect(reviewRepoSetSpy).toHaveBeenCalled();
      const output = writeFileSyncSpy.mock.calls[0][1] as string;
      expect(output).toContain('CALL STACK:');
      expect(output).toContain('STATE TRANSITION:');
      expect(output).toContain('APPROVAL STATUS: APPROVED');
      expect(output).toContain(
        'Provenance: best-effort (code-path trace inferred from the diff and AI output)',
      );
      expect(output).toContain(
        'Best effort: call stack is inferred from the changed code and AI output.',
      );
      expect(output).toContain(
        'Hindrance: there is no runtime execution trace backend in this path.',
      );
      expect(output.indexOf('SUMMARY:')).toBeLessThan(
        output.indexOf('ISSUES FOUND'),
      );
      expect(output.indexOf('ISSUES FOUND')).toBeLessThan(
        output.indexOf('CALL STACK:'),
      );
      expect(output.indexOf('CALL STACK:')).toBeLessThan(
        output.indexOf('STATE TRANSITION:'),
      );
      expect(output.indexOf('STATE TRANSITION:')).toBeLessThan(
        output.indexOf('SUGGESTIONS'),
      );
      expect(output.indexOf('SUGGESTIONS')).toBeLessThan(
        output.indexOf('APPROVAL STATUS'),
      );
    });

    it('renders unavailable trace sections when no code-path trace can be inferred', async () => {
      const { command } = await buildCommand();
      const mockDiff =
        'diff --git a/src/payment/payment.controller.ts b/src/payment/payment.controller.ts';

      const output = (command as any).formatReviewAsText([
        {
          title: 'Bitbucket PR #160',
          context:
            'pull request: https://bitbucket.org/workspace/repo/pull-requests/160',
          diff: mockDiff,
          review: {
            ...mockReview,
            traceProvenance: 'unavailable',
            callStack: [],
            stateTransition: {},
          },
        },
      ]);

      expect(output).toContain('CALL STACK:');
      expect(output).toContain(
        'Provenance: unavailable (no concrete code-path trace could be inferred from the diff)',
      );
      expect(output).toContain(
        'Trace unavailable: no concrete code-path trace could be inferred for the call stack section.',
      );
      expect(output).toContain(
        'Trace unavailable: no concrete code-path trace could be inferred for the state transition section.',
      );
    });
  });
});
