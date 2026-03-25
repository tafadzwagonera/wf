// Mock chalk before any imports
jest.mock('chalk', () => {
  const identity = (s: any) => s;
  const makeChain = () => {
    const chain: any = identity;
    [
      'bold', 'dim', 'italic', 'underline', 'inverse', 'strikethrough',
      'black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan',
      'white', 'gray', 'grey',
    ].forEach((name) => { chain[name] = identity; });
    return chain;
  };
  const chalk = makeChain();
  chalk.bold = makeChain();
  return { default: chalk, ...chalk };
});

jest.mock('../agents/utils', () => ({
  resolveRepoBasePath: jest.fn().mockReturnValue('/mock/repo'),
}));

import { Test } from '@nestjs/testing';
import { IssueReviewCommand } from './issue-review.command';
import { ClaudeService } from '../integrations/ai/claude.service';
import { GitService } from '../integrations/git/git.service';
import { PlatformService } from '../integrations/platforms/platform.service';
import { LoggerService } from '../shared/logger/logger.service';
import { DryRunPreviewService } from '../shared/preview/dry-run-preview.service';

const mockTicket = { key: 'TAD-575', summary: 'Test ticket', description: '' };

async function buildCommand(overrides?: {
  findPullRequestByTicketKey?: jest.Mock;
}): Promise<IssueReviewCommand> {
  const findPullRequestByTicketKey =
    overrides?.findPullRequestByTicketKey ?? jest.fn().mockResolvedValue(null);

  const module = await Test.createTestingModule({
    providers: [
      IssueReviewCommand,
      { provide: ClaudeService, useValue: {} },
      {
        provide: GitService,
        useValue: { getDiff: jest.fn().mockResolvedValue('') },
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

  return module.get(IssueReviewCommand);
}

describe('IssueReviewCommand', () => {
  describe('ticket key — no open PR', () => {
    let command: IssueReviewCommand;
    let exitSpy: jest.SpyInstance;
    let consoleErrorSpy: jest.SpyInstance;

    beforeEach(async () => {
      command = await buildCommand();
      exitSpy = jest
        .spyOn(process, 'exit')
        .mockImplementation((() => {}) as any);
      consoleErrorSpy = jest
        .spyOn(console, 'error')
        .mockImplementation(() => {});
    });

    afterEach(() => {
      exitSpy.mockRestore();
      consoleErrorSpy.mockRestore();
    });

    it('exits with code 1 when ticket key is supplied with --repos but no open PR is found', async () => {
      await command.run(['TAD-575'], { repos: ['service-tourv3'] });

      expect(exitSpy).toHaveBeenCalledWith(1);
      const errorOutput = consoleErrorSpy.mock.calls
        .map((c) => c.join(' '))
        .join('\n');
      expect(errorOutput).toContain('No open pull request found for TAD-575');
      expect(errorOutput).toContain('wf issue:review');
    });

    it('exits with code 1 when ticket key is supplied without --repos (PR search skipped)', async () => {
      await command.run(['TAD-575'], {});

      expect(exitSpy).toHaveBeenCalledWith(1);
      const errorOutput = consoleErrorSpy.mock.calls
        .map((c) => c.join(' '))
        .join('\n');
      expect(errorOutput).toContain('No open pull request found for TAD-575');
      expect(errorOutput).toContain('wf issue:review');
    });
  });
});
