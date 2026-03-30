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
      repo ? path.join('/tmp/consumer-app', repo) : '/tmp/consumer-app',
    ),
  };
});

import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { IssueGenerateCommand } from './issue-generate.command';
import { PlatformService } from '../integrations/platforms/platform.service';
import { FormatConverterService } from '../common/converters/format-converter.service';
import { AiService } from '../integrations/ai/ai.service';
import { LoggerService } from '../shared/logger/logger.service';
import { DryRunPreviewService } from '../shared/preview/dry-run-preview.service';
import { SlackService } from '../integrations/slack/slack.service';
import * as os from 'os';
import * as path from 'path';

const mockCwd = '/tmp/consumer-app';

async function buildCommand(): Promise<IssueGenerateCommand> {
  const module = await Test.createTestingModule({
    providers: [
      IssueGenerateCommand,
      { provide: PlatformService, useValue: {} },
      { provide: FormatConverterService, useValue: {} },
      {
        provide: AiService,
        useValue: {
          getProviderDisplayName: jest.fn().mockReturnValue('OpenAI'),
        },
      },
      {
        provide: ConfigService,
        useValue: {
          get: jest.fn((key: string, defaultValue?: string) => {
            if (key === 'output.defaultFormat') return 'md';
            if (key === 'platforms.primary') return 'jira';
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
      { provide: SlackService, useValue: {} },
    ],
  }).compile();

  return module.get(IssueGenerateCommand);
}

describe('IssueGenerateCommand', () => {
  let cwdSpy: jest.SpyInstance;

  beforeEach(() => {
    cwdSpy = jest.spyOn(process, 'cwd').mockReturnValue(mockCwd);
  });

  afterEach(() => {
    cwdSpy.mockRestore();
    jest.restoreAllMocks();
  });

  it('stores saved generated artifacts under the cwd namespace by default', async () => {
    const command = await buildCommand();
    const dryRunPreview = (command as any)
      .dryRunPreview as jest.Mocked<DryRunPreviewService>;

    await command.run(['ABC-123'], { save: true, dryRun: true });

    const preview = dryRunPreview.previewFileWrite.mock.calls[0][0];
    expect(path.dirname(preview.filePath)).toBe(
      path.join(os.homedir(), '.wf', 'consumer-app', 'jira'),
    );
  });

  it('stores saved generated artifacts under the targeted repo namespace when --repos is provided', async () => {
    const command = await buildCommand();
    const dryRunPreview = (command as any)
      .dryRunPreview as jest.Mocked<DryRunPreviewService>;

    await command.run(['ABC-123'], {
      save: true,
      repos: ['repo-a'],
      dryRun: true,
    });

    const preview = dryRunPreview.previewFileWrite.mock.calls[0][0];
    expect(path.dirname(preview.filePath)).toBe(
      path.join(os.homedir(), '.wf', 'repo-a', 'jira'),
    );
  });
});
