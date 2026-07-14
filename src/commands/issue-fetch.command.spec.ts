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

jest.mock('../shared/utils/ensure-wf-home', () => ({
  ensureWfHome: jest.fn(),
}));

jest.mock('../agents/utils', () => {
  const actual = jest.requireActual('../agents/utils');
  return {
    ...actual,
    resolveRepoBasePath: jest.fn((repo?: string) =>
      repo ? path.join('/tmp/consumer-app', repo) : '/tmp/consumer-app',
    ),
  };
});

import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { IssueFetchCommand } from './issue-fetch.command';
import { IssueTrackerService } from '../integrations/issue-trackers/issue-tracker.service';
import { LoggerService } from '../shared/logger/logger.service';
import { DryRunPreviewService } from '../shared/preview/dry-run-preview.service';
import { FetchStageService } from '../workflows/stages/fetch-stage.service';
import * as os from 'os';
import * as path from 'path';

const mockCwd = '/tmp/consumer-app';

async function buildCommand(): Promise<{
  command: IssueFetchCommand;
  fetchStageService: jest.Mocked<FetchStageService>;
}> {
  const module = await Test.createTestingModule({
    providers: [
      IssueFetchCommand,
      { provide: IssueTrackerService, useValue: {} },
      {
        provide: FetchStageService,
        useValue: {
          fetchTicket: jest.fn(),
        },
      },
      {
        provide: ConfigService,
        useValue: {
          get: jest.fn((key: string, defaultValue?: string) => {
            if (key === 'tracker') return 'jira';
            return defaultValue;
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
    command: module.get(IssueFetchCommand),
    fetchStageService: module.get(FetchStageService),
  };
}

describe('IssueFetchCommand', () => {
  let cwdSpy: jest.SpyInstance;

  beforeEach(() => {
    cwdSpy = jest.spyOn(process, 'cwd').mockReturnValue(mockCwd);
  });

  afterEach(() => {
    cwdSpy.mockRestore();
    jest.restoreAllMocks();
  });

  describe('parseRepos', () => {
    it('returns trimmed repo values from variadic option input', async () => {
      const { command } = await buildCommand();

      expect(command.parseRepos([' repo-a ', 'workspace/repo-b', ''] as any)).toEqual(['repo-a', 'workspace/repo-b']);
    });
  });

  describe('parseFormat', () => {
    it('accepts json|md|yaml|yml', async () => {
      const { command } = await buildCommand();

      expect(command.parseFormat('json')).toBe('json');
      expect(command.parseFormat('md')).toBe('md');
      expect(command.parseFormat('yaml')).toBe('yaml');
      expect(command.parseFormat('yml')).toBe('yml');
    });

    it('rejects xml', async () => {
      const { command } = await buildCommand();

      expect(() => command.parseFormat('xml')).toThrow('Invalid format');
    });
  });

  it('stores fetched artifacts under the cwd namespace by default', async () => {
    const { command } = await buildCommand();
    const dryRunPreview = (command as any).dryRunPreview as jest.Mocked<DryRunPreviewService>;

    await command.run(['WBP-1'], { dryRun: true });

    const preview = dryRunPreview.previewFileWrite.mock.calls[0][0];
    expect(path.dirname(preview.filePath)).toBe(path.join(os.homedir(), '.wf', 'consumer-app', 'jira'));
  });

  it('stores fetched artifacts under the targeted repo namespace when --repos is provided', async () => {
    const { command } = await buildCommand();
    const dryRunPreview = (command as any).dryRunPreview as jest.Mocked<DryRunPreviewService>;

    await command.run(['WBP-1'], { repos: ['repo-a'], dryRun: true });

    const preview = dryRunPreview.previewFileWrite.mock.calls[0][0];
    expect(path.dirname(preview.filePath)).toBe(path.join(os.homedir(), '.wf', 'repo-a', 'jira'));
  });

  it('stores fetched artifacts under the repo-name namespace for long-format repos', async () => {
    const { command } = await buildCommand();
    const dryRunPreview = (command as any).dryRunPreview as jest.Mocked<DryRunPreviewService>;

    await command.run(['WBP-1'], {
      repos: ['workspace/repo-a'],
      dryRun: true,
    });

    const preview = dryRunPreview.previewFileWrite.mock.calls[0][0];
    expect(path.dirname(preview.filePath)).toBe(path.join(os.homedir(), '.wf', 'repo-a', 'jira'));
  });

  it('delegates live ticket retrieval to FetchStageService', async () => {
    const { command, fetchStageService } = await buildCommand();
    fetchStageService.fetchTicket.mockResolvedValue({
      key: 'WBP-1',
      title: 'Fix auth flow',
      description: 'Restore auth flow',
      status: 'todo',
    } as any);

    const writeFileSpy = jest.spyOn(require('fs').promises, 'writeFile').mockResolvedValue(undefined);

    await command.run(['WBP-1'], { repos: ['repo-a'] });

    expect(fetchStageService.fetchTicket).toHaveBeenCalledWith('WBP-1', {
      trackerName: 'jira',
      repo: 'repo-a',
    });
    expect(writeFileSpy).toHaveBeenCalled();
  });
});
