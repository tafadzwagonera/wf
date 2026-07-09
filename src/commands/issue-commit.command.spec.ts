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
    ].forEach(name => {
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
    resolveRepoBasePath: jest.fn((repo?: string) => (repo ? `/tmp/repos/${repo}` : '/tmp/current-app')),
  };
});

import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { IssueCommitCommand } from './issue-commit.command';
import { GitService } from '../integrations/git/git.service';
import { AiService } from '../integrations/ai/ai.service';
import { LoggerService } from '../shared/logger/logger.service';
import { DryRunPreviewService } from '../shared/preview/dry-run-preview.service';
import { CommitStageService } from '../workflows/stages/commit-stage.service';

const mockGitService = {
  isGitRepository: jest.fn().mockResolvedValue(true),
  getDiff: jest.fn().mockResolvedValue('diff --git a/file b/file'),
  commit: jest.fn().mockResolvedValue('abc123'),
  getBranchInfo: jest.fn().mockResolvedValue({
    current: 'feature/WBP-123-change',
  }),
};

const mockAiService = {
  getProviderDisplayName: jest.fn().mockReturnValue('OpenAI'),
};

async function buildCommand(): Promise<{
  command: IssueCommitCommand;
  commitStageService: jest.Mocked<CommitStageService>;
}> {
  const module = await Test.createTestingModule({
    providers: [
      IssueCommitCommand,
      { provide: GitService, useValue: mockGitService },
      { provide: AiService, useValue: mockAiService },
      {
        provide: CommitStageService,
        useValue: {
          generateCommitMessage: jest.fn().mockResolvedValue('WBP-123: ship it'),
        },
      },
      {
        provide: ConfigService,
        useValue: { get: jest.fn() },
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
          previewGitOperation: jest.fn(),
        },
      },
    ],
  }).compile();

  return {
    command: module.get(IssueCommitCommand),
    commitStageService: module.get(CommitStageService),
  };
}

describe('IssueCommitCommand', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(process, 'cwd').mockReturnValue('/tmp/current-app');
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('uses process.cwd() as the git base when --repos is absent', async () => {
    const { command } = await buildCommand();

    await command.run([], { ticketKey: 'WBP-123', message: 'ship it' });

    expect(mockGitService.isGitRepository).toHaveBeenCalledWith('/tmp/current-app');
    expect(mockGitService.getDiff).toHaveBeenCalledWith(true, '/tmp/current-app');
    expect(mockGitService.commit).toHaveBeenCalledWith({
      message: 'WBP-123: ship it',
      cwd: '/tmp/current-app',
    });
  });

  it('uses only the first resolved repo and warns when multiple repos are provided', async () => {
    const { command } = await buildCommand();
    const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

    await command.run([], {
      ticketKey: 'WBP-123',
      message: 'ship it',
      repos: ['repo-a', 'repo-b'],
    });

    expect(mockGitService.isGitRepository).toHaveBeenCalledWith('/tmp/repos/repo-a');
    expect(mockGitService.getDiff).toHaveBeenCalledWith(true, '/tmp/repos/repo-a');
    expect(mockGitService.commit).toHaveBeenCalledWith({
      message: 'WBP-123: ship it',
      cwd: '/tmp/repos/repo-a',
    });
    expect(consoleSpy.mock.calls.some(call => String(call[0]).includes('Only the first repository'))).toBe(true);

    consoleSpy.mockRestore();
  });

  it('delegates AI commit message generation to CommitStageService', async () => {
    const { command, commitStageService } = await buildCommand();

    await command.run([], { ticketKey: 'WBP-123' });

    expect(commitStageService.generateCommitMessage).toHaveBeenCalledWith({
      diff: 'diff --git a/file b/file',
      ticketKey: 'WBP-123',
      conventional: undefined,
    });
    expect(mockGitService.commit).toHaveBeenCalledWith({
      message: 'WBP-123: ship it',
      cwd: '/tmp/current-app',
    });
  });
});
