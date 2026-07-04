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
    ].forEach(name => {
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

jest.mock('../shared/utils/ensure-wf-home', () => ({
  ensureWfHome: jest.fn(),
}));

jest.mock('../agents/utils', () => {
  const actual = jest.requireActual('../agents/utils');
  return {
    ...actual,
    resolveRepoBasePath: jest.fn((repo?: string) => (repo ? path.join('/mock', repo) : '/mock/repo')),
  };
});

import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import inquirer from 'inquirer';
import { IssueReviewCommand } from './issue-review.command';
import { AiService, CodeReview } from '../integrations/ai/ai.service';
import { GitService } from '../integrations/git/git.service';
import { IssueTrackerService } from '../integrations/issue-trackers/issue-tracker.service';
import { LoggerService } from '../shared/logger/logger.service';
import { DryRunPreviewService } from '../shared/preview/dry-run-preview.service';
import { ReviewStageService } from '../workflows/stages/review-stage.service';
import { ConversationService } from '../integrations/ai/conversation/conversation.service';
import { ErrorHandler } from '../shared/utils/error-handler';
import { resolveRepoBasePath } from '../agents/utils';
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
      suggestion: 'Add a regression test',
    },
  ],
  traceProvenance: 'best-effort',
  callStack: [
    {
      frame: 'TripcomController.syncProduct(productCode, slug)',
      children: [
        {
          frame: 'TripcomService.syncProductContent(productCode, slug)',
          children: [
            {
              frame: 'TripcomService.getTourBySlug(slug)',
              children: [
                {
                  frame: 'AgentApiClient.fetchAgentApiData()',
                  children: [
                    {
                      frame: 'HttpClient.get(GET https://agentapi.expatexplore.com/agent/1.0/data)',
                    },
                  ],
                },
              ],
            },
            {
              frame: 'TripcomMapper.mapAgentApiToTripcom(productCode, tour)',
              children: [
                {
                  frame: 'TripcomMapper.mapGalleryToMedias(tour.gallery, tour.title)',
                  children: [
                    {
                      frame: 'Array.prototype.slice(0, 10)',
                    },
                  ],
                },
                {
                  frame: 'TripcomMapper.mapItineraryToTourInfoList(tour)',
                },
                {
                  frame: 'TripcomMapper.mapIncludedToClauses(tour)',
                },
              ],
            },
            {
              frame: 'TripcomApiClient.syncProduct(mappedProduct)',
              children: [
                {
                  frame: 'HttpClient.post(POST {TRIPCOM_API_URL}/syncProduct)',
                },
              ],
            },
          ],
        },
      ],
    },
  ],
  stateTransition: {
    from: 'canonicalCustomerId',
    to: 'ProfileResponse.linkedProfiles',
    steps: [
      {
        frame: 'CanonicalProfileRepository.findLinkedProfiles(canonicalCustomerId)',
        captured: {
          canonicalCustomerId: '123',
        },
        changes: {
          'firstName.dep': {
            after: {
              version: 1,
              subs: 'Link_1',
              subsHead: 'Link_1',
              sc: 1,
            },
          },
        },
        children: [
          {
            frame:
              'CanonicalLinkRepository.find({ where: { canonicalCustomerId, linkStatus: CanonicalLinkStatus.Merged } })',
            changes: {
              'lastName.dep': {
                after: {
                  version: 1,
                  subs: 'Link_2',
                  subsHead: 'Link_2',
                  sc: 1,
                },
              },
            },
            children: [
              {
                frame:
                  'CanonicalProfileRepository.findLinkedProfiles(...): In([...customerIds]) -> AppGoldenCustomerProfile[]',
                changes: {
                  'fullName.dep': {
                    before: {
                      version: 1,
                    },
                    after: {
                      version: 0,
                      subs: 'Link_3',
                      subsHead: 'Link_3',
                      computed: 'fullName',
                      sc: 1,
                    },
                  },
                },
                children: [
                  {
                    frame: 'ProfileResponseDto.linkedProfiles',
                    captured: {
                      'fullName._value': 'Jane Smith',
                    },
                    children: [
                      {
                        frame: 'LinkedProfileSummaryDto',
                      },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
  },
  suggestions: [],
  approved: true,
};

const buildAdapter = (name: string, defaults: Record<string, any> = {}) => ({
  getTrackerName: jest.fn().mockReturnValue(name),
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

const mockConversationService = {
  loadConversation: jest.fn().mockResolvedValue(null),
  createConversation: jest.fn().mockResolvedValue({
    conversationId: 'mock-conv-id',
    ticketKey: 'review',
    messages: [],
    context: {},
    totalTokensUsed: { input: 0, output: 0 },
    createdAt: new Date(),
    updatedAt: new Date(),
  }),
  startChatSession: jest.fn().mockResolvedValue(undefined),
};

async function buildCommand(overrides?: { ticketAdapterName?: 'jira' | 'github' | 'bitbucket' }): Promise<{
  command: IssueReviewCommand;
  reviewStageService: jest.Mocked<ReviewStageService>;
  adapters: Record<string, any>;
  promptMock: jest.MockedFunction<typeof inquirer.prompt>;
  conversationService: typeof mockConversationService;
  dryRunPreview: {
    showHeader: jest.Mock;
    showSkipped: jest.Mock;
    showSummary: jest.Mock;
    showValidationResult: jest.Mock;
    previewApiCall: jest.Mock;
    previewFileRead: jest.Mock;
    previewFileWrite: jest.Mock;
  };
}> {
  const jiraAdapter = buildAdapter(
    'jira',
    overrides?.ticketAdapterName === 'jira'
      ? { getTicket: jest.fn().mockResolvedValue(mockTicket) }
      : {
          getTicket: jest.fn().mockRejectedValue(new Error('Unexpected ticket lookup')),
        }
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

  const promptMock = inquirer.prompt as jest.MockedFunction<typeof inquirer.prompt>;
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
        provide: ConfigService,
        useValue: {
          get: jest.fn((key: string, defaultValue?: string) => defaultValue),
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
        provide: IssueTrackerService,
        useValue: {
          getDefaultAdapter: jest.fn().mockReturnValue(jiraAdapter),
          getAdapter: jest.fn((trackerName: string) => {
            if (trackerName === 'jira') return jiraAdapter;
            if (trackerName === 'github') return githubAdapter;
            if (trackerName === 'bitbucket') return bitbucketAdapter;
            throw new Error(`Unknown platform: ${trackerName}`);
          }),
          getPullRequestDiscoveryAdapters: jest.fn().mockReturnValue(
            new Map([
              ['bitbucket', bitbucketAdapter],
              ['github', githubAdapter],
            ])
          ),
          getAllAdapters: jest.fn().mockReturnValue(
            new Map([
              ['bitbucket', bitbucketAdapter],
              ['github', githubAdapter],
              ['jira', jiraAdapter],
            ])
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
        provide: ConversationService,
        useValue: mockConversationService,
      },
      {
        provide: DryRunPreviewService,
        useValue: {
          showHeader: jest.fn(),
          showSkipped: jest.fn(),
          showSummary: jest.fn(),
          showValidationResult: jest.fn(),
          previewApiCall: jest.fn(),
          previewFileRead: jest.fn(),
          previewFileWrite: jest.fn(),
        },
      },
    ],
  }).compile();

  const dryRunPreview = module.get<{
    showHeader: jest.Mock;
    showSkipped: jest.Mock;
    showSummary: jest.Mock;
    showValidationResult: jest.Mock;
    previewApiCall: jest.Mock;
    previewFileRead: jest.Mock;
    previewFileWrite: jest.Mock;
  }>(DryRunPreviewService);

  return {
    command: module.get(IssueReviewCommand),
    reviewStageService: module.get(ReviewStageService),
    adapters: {
      jiraAdapter,
      githubAdapter,
      bitbucketAdapter,
    },
    promptMock,
    conversationService: mockConversationService,
    dryRunPreview,
  };
}

describe('IssueReviewCommand', () => {
  afterEach(() => {
    setNonInteractiveSession();
    jest.restoreAllMocks();
    jest.clearAllMocks();
  });

  describe('parseFormat', () => {
    it('accepts json|md|yaml|yml', async () => {
      const { command } = await buildCommand();

      expect(command.parseFormat('json')).toBe('json');
      expect(command.parseFormat('md')).toBe('md');
      expect(command.parseFormat('yaml')).toBe('yaml');
      expect(command.parseFormat('yml')).toBe('yml');
    });

    it('rejects xml and text', async () => {
      const { command } = await buildCommand();

      expect(() => command.parseFormat('xml')).toThrow('Invalid format');
      expect(() => command.parseFormat('text')).toThrow('Invalid format');
    });
  });

  describe('parseRepos', () => {
    it('returns trimmed repo values from variadic option input', async () => {
      const { command } = await buildCommand();

      expect(command.parseRepos([' repo-a ', 'workspace/repo-b', ''] as any)).toEqual(['repo-a', 'workspace/repo-b']);
    });
  });

  describe('ticket-driven review', () => {
    beforeEach(() => {
      jest.spyOn(require('fs'), 'existsSync').mockReturnValue(false);
      jest.spyOn(require('fs'), 'mkdirSync').mockImplementation(() => undefined);
      jest.spyOn(require('fs'), 'writeFileSync').mockImplementation(() => undefined);
    });

    it('skips AI review when cached review artifact exists for ticket key', async () => {
      const { command, reviewStageService, adapters } = await buildCommand();
      const existsSyncSpy = jest.spyOn(require('fs'), 'existsSync').mockImplementation((targetPath: string) => {
        if (targetPath === '/Users/tafadzwagonera/.wf/wf/jira/TAD-575-review.md') {
          return true;
        }

        return false;
      });
      const readFileSyncSpy = jest
        .spyOn(require('fs'), 'readFileSync')
        .mockReturnValue('# Cached review\n\nAlready reviewed.');
      const reviewPullRequestSpy = jest.spyOn(command as any, 'reviewPullRequest');
      const consoleLogSpy = jest.spyOn(console, 'log').mockImplementation();
      adapters.bitbucketAdapter.findPullRequestsByTicketKey.mockResolvedValue([
        'https://bitbucket.org/workspace/repo/pull-requests/160',
      ]);
      adapters.bitbucketAdapter.getPullRequestDiff.mockResolvedValue('diff 160');

      await command.run(['TAD-575'], { repos: ['service-tourv3'] });

      expect(existsSyncSpy).toHaveBeenCalledWith('/Users/tafadzwagonera/.wf/wf/jira/TAD-575-review.md');
      expect(readFileSyncSpy).not.toHaveBeenCalled();
      expect(adapters.bitbucketAdapter.findPullRequestsByTicketKey).not.toHaveBeenCalled();
      expect(reviewPullRequestSpy).not.toHaveBeenCalled();
      expect(reviewStageService.reviewDiff).not.toHaveBeenCalled();
      expect(consoleLogSpy).toHaveBeenCalledWith(
        '  Review artifact exists: /Users/tafadzwagonera/.wf/wf/jira/TAD-575-review.md'
      );
      expect(consoleLogSpy).toHaveBeenCalledWith('  Use --force to regenerate.\n');
    });

    it('uses the cached review artifact without fetching the ticket', async () => {
      const { command, reviewStageService, adapters } = await buildCommand();

      jest.spyOn(require('fs'), 'existsSync').mockImplementation((targetPath: string) => {
        if (targetPath === '/Users/tafadzwagonera/.wf/wf/jira/TAD-575-review.md') {
          return true;
        }

        return false;
      });
      jest.spyOn(require('fs'), 'readFileSync').mockReturnValue('# Cached review\n\nAlready reviewed.');
      adapters.jiraAdapter.getTicket.mockRejectedValue(new Error('ticket lookup should be skipped'));
      const handleSpy = jest.spyOn(ErrorHandler, 'handle').mockImplementation(() => undefined as never);

      await command.run(['TAD-575'], { repos: ['service-tourv3'] });

      expect(adapters.jiraAdapter.getTicket).not.toHaveBeenCalled();
      expect(reviewStageService.reviewDiff).not.toHaveBeenCalled();
      expect(handleSpy).not.toHaveBeenCalled();
    });

    it('runs AI review with --force even when cached artifact exists', async () => {
      const { command, reviewStageService, adapters } = await buildCommand();

      jest.spyOn(require('fs'), 'existsSync').mockImplementation((targetPath: string) => {
        if (targetPath === '/Users/tafadzwagonera/.wf/wf/jira/TAD-575-review.md') {
          return true;
        }

        return false;
      });
      const loggerInfoSpy = jest.spyOn((command as any).logger, 'info');
      adapters.bitbucketAdapter.findPullRequestsByTicketKey.mockResolvedValue([
        'https://bitbucket.org/workspace/repo/pull-requests/160',
      ]);
      adapters.bitbucketAdapter.getPullRequestDiff.mockResolvedValue('diff 160');

      await command.run(['TAD-575'], { repos: ['service-tourv3'], force: true });

      expect(loggerInfoSpy).toHaveBeenCalledWith('Forcing recreation of review artifact...');
      expect(reviewStageService.reviewDiff).toHaveBeenCalledWith(
        'diff 160',
        expect.objectContaining({
          context: expect.stringContaining('ticket TAD-575'),
        })
      );
    });

    it('reviews open pull request diffs instead of local changes when PRs are discovered', async () => {
      const { command, reviewStageService, adapters } = await buildCommand();
      const reviewRepoSetSpy = jest.spyOn(command as any, 'reviewRepoSet').mockResolvedValue('local diff');

      adapters.bitbucketAdapter.findPullRequestsByTicketKey.mockResolvedValue([
        'https://bitbucket.org/workspace/repo/pull-requests/161',
        'https://bitbucket.org/workspace/repo/pull-requests/160',
      ]);
      adapters.bitbucketAdapter.getPullRequestDiff.mockImplementation(async (url: string) =>
        url.includes('/160') ? 'diff 160' : 'diff 161'
      );

      await command.run(['TAD-575'], { repos: ['service-tourv3'] });

      expect(reviewRepoSetSpy).not.toHaveBeenCalled();
      expect(reviewStageService.reviewDiff).toHaveBeenNthCalledWith(
        1,
        'diff 160',
        expect.objectContaining({
          context: expect.stringContaining('ticket TAD-575'),
        })
      );
      expect(reviewStageService.reviewDiff).toHaveBeenNthCalledWith(
        2,
        'diff 161',
        expect.objectContaining({
          context: expect.stringContaining('pull request: https://bitbucket.org/workspace/repo/pull-requests/161'),
        })
      );
    });

    it('uses the current repo name as a discovery hint when --repos is omitted', async () => {
      const { command, adapters } = await buildCommand();
      const handleSpy = jest.spyOn(ErrorHandler, 'handle').mockImplementation(() => undefined as never);
      const consoleLogSpy = jest.spyOn(console, 'log').mockImplementation();
      adapters.bitbucketAdapter.findPullRequestsByTicketKey.mockResolvedValue([]);
      adapters.githubAdapter.findPullRequestsByTicketKey.mockResolvedValue([]);
      setNonInteractiveSession();

      await command.run(['TAD-575'], {});

      expect(adapters.bitbucketAdapter.findPullRequestsByTicketKey).toHaveBeenCalledWith(
        'TAD-575',
        path.basename(process.cwd())
      );
      expect(handleSpy).not.toHaveBeenCalled();
      expect(consoleLogSpy).toHaveBeenCalledWith('⚠️ Non-interactive session; returning without local review');
    });

    it('does not warn about cwd fallback when remote ticket PR review succeeds without a local checkout', async () => {
      const { command, adapters } = await buildCommand();
      const resolveRepoBasePathMock = resolveRepoBasePath as jest.MockedFunction<typeof resolveRepoBasePath>;

      resolveRepoBasePathMock.mockImplementation((repo?: string) =>
        repo === 'api-gateway-v1' ? process.cwd() : repo ? path.join('/mock', repo) : '/mock/repo'
      );
      adapters.bitbucketAdapter.findPullRequestsByTicketKey.mockResolvedValue([
        'https://bitbucket.org/workspace/repo/pull-requests/43',
      ]);
      adapters.bitbucketAdapter.getPullRequestDiff.mockResolvedValue('diff 43');

      await command.run(['TAD-575'], { repos: ['api-gateway-v1'] });

      expect(resolveRepoBasePathMock).not.toHaveBeenCalledWith('api-gateway-v1');
    });

    it('fails hard when ticket lookup does not succeed', async () => {
      const { command, adapters } = await buildCommand();
      const handleSpy = jest.spyOn(ErrorHandler, 'handle').mockImplementation(() => undefined as never);

      adapters.jiraAdapter.getTicket.mockRejectedValue(new Error('boom'));

      await command.run(['TAD-575'], {});

      expect(handleSpy).toHaveBeenCalledWith(expect.objectContaining({ message: 'boom' }));
    });

    it('prompts for local review when no pull request is found', async () => {
      const { command, reviewStageService, adapters, promptMock } = await buildCommand();
      const reviewRepoSetSpy = jest.spyOn(command as any, 'reviewRepoSet').mockResolvedValue('local diff');
      jest.spyOn(command as any, 'canResolveRepoLocally').mockReturnValue(true);

      adapters.bitbucketAdapter.findPullRequestsByTicketKey.mockResolvedValue([]);
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
        })
      );
    });

    it('fails when ticket review would fall back to local changes for an unresolved repo input', async () => {
      const { command, reviewStageService, adapters, promptMock } = await buildCommand();
      const reviewRepoSetSpy = jest.spyOn(command as any, 'reviewRepoSet');
      jest.spyOn(command as any, 'canResolveRepoLocally').mockReturnValue(false);
      const handleSpy = jest.spyOn(ErrorHandler, 'handle').mockImplementation(() => undefined as never);
      const resolveRepoBasePathMock = resolveRepoBasePath as jest.MockedFunction<typeof resolveRepoBasePath>;

      resolveRepoBasePathMock.mockImplementation((repo?: string) =>
        repo === 'api-gateway-v1' ? process.cwd() : repo ? path.join('/mock', repo) : '/mock/repo'
      );
      adapters.bitbucketAdapter.findPullRequestsByTicketKey.mockResolvedValue([]);
      adapters.githubAdapter.findPullRequestsByTicketKey.mockResolvedValue([]);
      setInteractiveSession();

      await command.run(['TAD-575'], { repos: ['api-gateway-v1'] });

      expect(handleSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          message: expect.stringContaining(
            "Repository 'api-gateway-v1' was provided for ticket review but was not found as a local path or sibling directory."
          ),
        })
      );
      expect(promptMock).not.toHaveBeenCalled();
      expect(reviewRepoSetSpy).not.toHaveBeenCalled();
      expect(reviewStageService.reviewDiff).not.toHaveBeenCalled();
    });

    it('fails with an actionable error when discovery cannot run without remote repo scope', async () => {
      const { command, reviewStageService, adapters, promptMock } = await buildCommand();
      const reviewRepoSetSpy = jest.spyOn(command as any, 'reviewRepoSet');
      const handleSpy = jest.spyOn(ErrorHandler, 'handle').mockImplementation(() => undefined as never);

      adapters.bitbucketAdapter.findPullRequestsByTicketKey.mockRejectedValue(
        new Error('No BitBucket repository specified. Provide the repository as "workspace/repo".')
      );
      adapters.githubAdapter.findPullRequestsByTicketKey.mockRejectedValue(
        new Error(
          'No GitHub repository specified and no default repository configured. Provide project as "owner/repo" or set github.defaultRepo in wf.config.*.'
        )
      );
      setInteractiveSession();

      await command.run(['TAD-575'], {});

      expect(handleSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          message: expect.stringContaining('Pull request discovery for ticket TAD-575 requires a repository'),
        })
      );
      expect(promptMock).not.toHaveBeenCalled();
      expect(reviewRepoSetSpy).not.toHaveBeenCalled();
      expect(reviewStageService.reviewDiff).not.toHaveBeenCalled();
    });

    it('fans out only across credentialed pull-request discovery adapters', async () => {
      const { command, reviewStageService, adapters, promptMock } = await buildCommand();
      const reviewRepoSetSpy = jest.spyOn(command as any, 'reviewRepoSet').mockResolvedValue('local diff');
      const consoleLogSpy = jest.spyOn(console, 'log').mockImplementation();
      jest.spyOn(command as any, 'canResolveRepoLocally').mockReturnValue(true);

      adapters.bitbucketAdapter.findPullRequestsByTicketKey.mockResolvedValue([]);
      promptMock.mockResolvedValue({ decision: 'local' } as any);
      setInteractiveSession();

      await command.run(['TAD-575'], { repos: ['service-tourv3'] });

      expect(reviewRepoSetSpy).toHaveBeenCalled();
      expect(adapters.githubAdapter.findPullRequestsByTicketKey).toHaveBeenCalled();
      expect(reviewStageService.reviewDiff).toHaveBeenCalledWith(
        'local diff',
        expect.objectContaining({
          context: expect.stringContaining('repositories under review'),
        })
      );
      expect(consoleLogSpy).not.toHaveBeenCalledWith(expect.stringContaining('PR discovery skipped for github'));
    });

    it('returns without reviewing when the fallback prompt selects return', async () => {
      const { command, reviewStageService, adapters, promptMock } = await buildCommand();
      const reviewRepoSetSpy = jest.spyOn(command as any, 'reviewRepoSet');
      jest.spyOn(command as any, 'canResolveRepoLocally').mockReturnValue(true);

      adapters.bitbucketAdapter.findPullRequestsByTicketKey.mockResolvedValue([]);
      adapters.githubAdapter.findPullRequestsByTicketKey.mockResolvedValue([]);
      promptMock.mockResolvedValue({ decision: 'return' } as any);
      setInteractiveSession();

      await command.run(['TAD-575'], { repos: ['service-tourv3'] });

      expect(promptMock).toHaveBeenCalled();
      expect(reviewRepoSetSpy).not.toHaveBeenCalled();
      expect(reviewStageService.reviewDiff).not.toHaveBeenCalled();
    });

    it('logs the standardized non-interactive warning before returning', async () => {
      const { command, reviewStageService, adapters, promptMock } = await buildCommand();
      const reviewRepoSetSpy = jest.spyOn(command as any, 'reviewRepoSet');
      const consoleLogSpy = jest.spyOn(console, 'log').mockImplementation();
      jest.spyOn(command as any, 'canResolveRepoLocally').mockReturnValue(true);

      adapters.bitbucketAdapter.findPullRequestsByTicketKey.mockResolvedValue([]);
      adapters.githubAdapter.findPullRequestsByTicketKey.mockResolvedValue([]);
      setNonInteractiveSession();

      await command.run(['TAD-575'], { repos: ['service-tourv3'] });

      expect(consoleLogSpy).toHaveBeenCalledWith('⚠️ Non-interactive session; returning without local review');
      expect(promptMock).not.toHaveBeenCalled();
      expect(reviewRepoSetSpy).not.toHaveBeenCalled();
      expect(reviewStageService.reviewDiff).not.toHaveBeenCalled();
    });

    it('posts comments to each reviewed pull request', async () => {
      const { command, adapters } = await buildCommand();

      adapters.bitbucketAdapter.findPullRequestsByTicketKey.mockResolvedValue([
        'https://bitbucket.org/workspace/repo/pull-requests/161',
        'https://bitbucket.org/workspace/repo/pull-requests/160',
      ]);
      adapters.bitbucketAdapter.getPullRequestDiff.mockImplementation(async (url: string) =>
        url.includes('/160') ? 'diff 160' : 'diff 161'
      );

      await command.run(['TAD-575'], {
        repos: ['service-tourv3'],
        comment: true,
      });

      expect(adapters.bitbucketAdapter.createComment).toHaveBeenCalledTimes(2);
      expect(adapters.bitbucketAdapter.createComment).toHaveBeenNthCalledWith(
        1,
        'https://bitbucket.org/workspace/repo/pull-requests/160',
        expect.stringContaining('## AI Code Review')
      );
      expect(adapters.bitbucketAdapter.createComment).toHaveBeenNthCalledWith(
        2,
        'https://bitbucket.org/workspace/repo/pull-requests/161',
        expect.stringContaining('## AI Code Review')
      );
    });

    it('saves review artifact to .wf/ after ticket-keyed review', async () => {
      const { command, adapters } = await buildCommand();
      const mkdirSyncSpy = jest.spyOn(require('fs'), 'mkdirSync').mockImplementation(() => undefined);
      const writeFileSyncSpy = jest.spyOn(require('fs'), 'writeFileSync').mockImplementation(() => undefined);

      adapters.bitbucketAdapter.findPullRequestsByTicketKey.mockResolvedValue([
        'https://bitbucket.org/workspace/repo/pull-requests/160',
      ]);
      adapters.bitbucketAdapter.getPullRequestDiff.mockResolvedValue('diff 160');

      await command.run(['TAD-575'], { repos: ['service-tourv3'] });

      expect(mkdirSyncSpy).toHaveBeenCalledWith('/Users/tafadzwagonera/.wf/wf/jira', { recursive: true });
      expect(writeFileSyncSpy).toHaveBeenCalledWith(
        '/Users/tafadzwagonera/.wf/wf/jira/TAD-575-review.md',
        expect.stringContaining('Code Review Report')
      );
    });
  });

  describe('saved output', () => {
    it('--force has no effect on local diff reviews', async () => {
      const { command, reviewStageService } = await buildCommand();
      const reviewRepoSetSpy = jest.spyOn(command as any, 'reviewRepoSet').mockResolvedValue('diff content');

      await command.run([], { force: true });

      expect(reviewRepoSetSpy).toHaveBeenCalled();
      expect(reviewStageService.reviewDiff).toHaveBeenCalledWith(
        'diff content',
        expect.objectContaining({
          context: expect.stringContaining('current repository changes'),
        })
      );
    });

    it('includes the absolute repo root in the dry-run header for local review', async () => {
      const { command, dryRunPreview } = await buildCommand();

      await command.run([], { dryRun: true });

      expect(dryRunPreview.showHeader).toHaveBeenCalledWith('issue:review', expect.stringContaining(process.cwd()));
      expect(dryRunPreview.showHeader).toHaveBeenCalledWith('issue:review', expect.stringContaining('current repo'));
    });

    it('shows a cached ticket review as skipped during dry run', async () => {
      const { command, dryRunPreview } = await buildCommand();

      jest.spyOn(require('fs'), 'existsSync').mockImplementation((targetPath: string) => {
        if (targetPath === '/Users/tafadzwagonera/.wf/wf/jira/TAD-575-review.md') {
          return true;
        }

        return false;
      });
      jest.spyOn(require('fs'), 'statSync').mockReturnValue({ size: 2048 } as any);

      await command.run(['TAD-575'], { dryRun: true, repos: ['service-tourv3'] });

      expect(dryRunPreview.previewFileRead).toHaveBeenCalledWith({
        filePath: '/Users/tafadzwagonera/.wf/wf/jira/TAD-575-review.md',
        exists: true,
        sizeInKb: '2.00',
      });
      expect(dryRunPreview.showSummary).toHaveBeenCalledWith(
        expect.objectContaining({
          apiCallCount: 0,
        })
      );
    });

    it('prints only the output path for silent cached reviews', async () => {
      const { command, adapters } = await buildCommand();

      jest.spyOn(require('fs'), 'existsSync').mockImplementation((targetPath: string) => {
        if (targetPath === '/Users/tafadzwagonera/.wf/wf/jira/TAD-575-review.md') {
          return true;
        }

        return false;
      });
      jest.spyOn(require('fs'), 'readFileSync').mockReturnValue('# Cached review\n\nAlready reviewed.');
      const consoleLogSpy = jest.spyOn(console, 'log').mockImplementation();
      adapters.jiraAdapter.getTicket.mockRejectedValue(new Error('ticket lookup should be skipped'));

      await command.run(['TAD-575'], { repos: ['service-tourv3'], output: 'review.txt', silent: true });

      expect(consoleLogSpy).toHaveBeenCalledTimes(1);
      expect(consoleLogSpy).toHaveBeenCalledWith('/Users/tafadzwagonera/.wf/wf/review.txt');
    });

    it('writes the new review sections in the expected order', async () => {
      const { command } = await buildCommand();
      const reviewRepoSetSpy = jest.spyOn(command as any, 'reviewRepoSet').mockResolvedValue('diff content');
      const writeFileSyncSpy = jest.spyOn(require('fs'), 'writeFileSync').mockImplementation(() => {});

      await command.run([], { output: 'review.txt' });

      expect(reviewRepoSetSpy).toHaveBeenCalled();
      const output = writeFileSyncSpy.mock.calls[0][1] as string;
      expect(output).toContain('CALL STACK:');
      expect(output).toContain('STATE TRANSITION:');
      expect(output).toContain('APPROVAL STATUS: APPROVED');
      expect(output).toContain('Provenance: best-effort (code-path trace inferred from the diff and AI output)');
      expect(output).toContain('Execution mode: standard');
      expect(output).toContain('Best effort: call stack is inferred from the changed code and AI output.');
      expect(output).toContain('Hindrance: there is no runtime execution trace backend in this path.');
      expect(output).toContain('TripcomController.syncProduct(productCode, slug)');
      expect(output).toContain('CanonicalProfileRepository.findLinkedProfiles(canonicalCustomerId)');
      expect(output).toContain('fullName._value = Jane Smith');
      expect(output.indexOf('SUMMARY:')).toBeLessThan(output.indexOf('ISSUES FOUND'));
      expect(output.indexOf('ISSUES FOUND')).toBeLessThan(output.indexOf('CALL STACK:'));
      expect(output.indexOf('CALL STACK:')).toBeLessThan(output.indexOf('STATE TRANSITION:'));
      expect(output).toContain('Suggestion: Add a regression test');
      expect(output.indexOf('STATE TRANSITION:')).toBeLessThan(output.indexOf('APPROVAL STATUS'));
      expect(output).not.toContain('SUGGESTIONS (1):');
    });

    it('renders unavailable trace sections when no code-path trace can be inferred', async () => {
      const { command } = await buildCommand();
      const mockDiff = 'diff --git a/src/payment/payment.controller.ts b/src/payment/payment.controller.ts';

      const output = (command as any).formatReviewAsText([
        {
          title: 'Bitbucket PR #160',
          context: 'pull request: https://bitbucket.org/workspace/repo/pull-requests/160',
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
      expect(output).toContain('Provenance: unavailable (no concrete code-path trace could be inferred from the diff)');
      expect(output).toContain('Execution mode: standard');
      expect(output).toContain(
        'Trace unavailable: no concrete code-path trace could be inferred for the call stack section.'
      );
      expect(output).toContain(
        'Trace unavailable: no concrete code-path trace could be inferred for the state transition section.'
      );
    });

    it('renders evidence-based provenance with agent execution mode for agent-backed traces', async () => {
      const { command } = await buildCommand();

      const output = (command as any).formatReviewAsText([
        {
          title: 'Bitbucket PR #160',
          context: 'pull request: https://bitbucket.org/workspace/repo/pull-requests/160',
          diff: 'diff --git a/src/auth.ts b/src/auth.ts',
          review: {
            ...mockReview,
            executionMode: 'agent',
          },
        },
      ]);

      expect(output).toContain('Execution mode: agent');
      expect(output).toContain('Provenance: evidence-based (code-path trace backed by the execution backend)');
      expect(output).not.toContain('Execution mode: standard\n  Provenance: evidence-based');
    });

    it('renders paired suggestions directly under each issue in text output and keeps extras trailing', async () => {
      const { command } = await buildCommand();

      const output = (command as any).formatReviewBlockText({
        ...mockReview,
        issues: [
          {
            severity: 'warning',
            message: 'First issue',
            file: 'src/first.ts',
            line: 10,
            suggestion: 'First suggestion',
          },
          {
            severity: 'error',
            message: 'Second issue',
            file: 'src/second.ts',
            line: 20,
            suggestion: 'Second suggestion',
          },
        ],
        suggestions: ['Extra idea'],
      });

      expect(output).toContain('1. [WARNING] First issue');
      expect(output).toContain('   Suggestion: First suggestion');
      expect(output.indexOf('1. [WARNING] First issue')).toBeLessThan(
        output.indexOf('   Suggestion: First suggestion')
      );
      expect(output.indexOf('   Suggestion: First suggestion')).toBeLessThan(output.indexOf('2. [ERROR] Second issue'));
      expect(output).toContain('SUGGESTIONS (1):');
      expect(output).toContain('1. Extra idea');
    });

    it('renders paired suggestions directly under each issue in PR comments', async () => {
      const { command } = await buildCommand();

      const output = (command as any).formatReviewAsComment({
        ...mockReview,
        issues: [
          {
            severity: 'warning',
            message: 'Inline issue',
            file: 'src/inline.ts',
            line: 24,
            suggestion: 'Pair this suggestion',
          },
        ],
        suggestions: ['Trailing suggestion'],
      });

      expect(output).toContain('- [warning] Inline issue (src/inline.ts:24)\n  Suggestion: Pair this suggestion');
      expect(output).toContain('### Suggestions');
      expect(output).toContain('- Trailing suggestion');
    });

    it('keeps detached legacy suggestions in the trailing section instead of pairing by index', async () => {
      const { command } = await buildCommand();

      const output = (command as any).formatReviewBlockText({
        ...mockReview,
        issues: [
          {
            severity: 'warning',
            message: 'First issue',
            file: 'src/first.ts',
            line: 10,
          },
        ],
        suggestions: ['Detached suggestion'],
      });

      expect(output).not.toContain('   Suggestion: Detached suggestion');
      expect(output).toContain('SUGGESTIONS (1):');
      expect(output).toContain('1. Detached suggestion');
    });

    it('posts inline comments with the normalized issue line from the review result', async () => {
      const { command, adapters, reviewStageService } = await buildCommand();

      reviewStageService.reviewDiff.mockResolvedValue({
        ...mockReview,
        issues: [
          {
            severity: 'warning',
            message: 'Normalized inline issue',
            file: 'src/inline.ts',
            line: 24,
          },
        ],
        suggestions: [],
      });
      adapters.bitbucketAdapter.getPullRequestDiff.mockResolvedValue('diff 24');

      await command.run(['https://bitbucket.org/workspace/repo/pull-requests/160'], { comment: true });

      expect(adapters.bitbucketAdapter.createInlineComment).toHaveBeenCalledWith(
        'https://bitbucket.org/workspace/repo/pull-requests/160',
        'src/inline.ts',
        24,
        'Normalized inline issue'
      );
    });
  });

  describe('interactive follow-up chat', () => {
    it('prompts for interactive chat after review when TTY is available', async () => {
      const { command, promptMock, conversationService } = await buildCommand();
      jest.spyOn(command as any, 'reviewRepoSet').mockResolvedValue('diff content');
      setInteractiveSession();

      promptMock.mockResolvedValue({ startChat: true } as any);

      await command.run([], {});

      expect(promptMock).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({
            message: 'Would you like to discuss the review?',
          }),
        ])
      );
      expect(conversationService.startChatSession).toHaveBeenCalledWith(
        'mock-conv-id',
        expect.objectContaining({
          maxTurns: 20,
          exitCommands: ['exit', 'quit', 'continue'],
        })
      );
    });

    it('skips interactive chat prompt in silent mode', async () => {
      const { command, promptMock, conversationService } = await buildCommand();
      jest.spyOn(command as any, 'reviewRepoSet').mockResolvedValue('diff content');
      setInteractiveSession();

      await command.run([], { silent: true });

      expect(promptMock).not.toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({
            message: 'Would you like to discuss the review?',
          }),
        ])
      );
      expect(conversationService.startChatSession).not.toHaveBeenCalled();
    });

    it('skips interactive chat prompt in non-interactive session', async () => {
      const { command, promptMock, conversationService } = await buildCommand();
      jest.spyOn(command as any, 'reviewRepoSet').mockResolvedValue('diff content');
      setNonInteractiveSession();

      await command.run([], {});

      expect(promptMock).not.toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({
            message: 'Would you like to discuss the review?',
          }),
        ])
      );
      expect(conversationService.startChatSession).not.toHaveBeenCalled();
    });

    it('still outputs artifact path in silent mode', async () => {
      const { command } = await buildCommand();
      jest.spyOn(command as any, 'reviewRepoSet').mockResolvedValue('diff content');
      const writeFileSyncSpy = jest.spyOn(require('fs'), 'writeFileSync').mockImplementation(() => {});
      const consoleLogSpy = jest.spyOn(console, 'log').mockImplementation();

      await command.run([], { silent: true, output: 'review.txt' });

      expect(writeFileSyncSpy).toHaveBeenCalled();
      expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('review.txt'));
    });
  });
});
