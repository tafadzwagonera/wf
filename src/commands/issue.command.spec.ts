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
import { CommandMeta } from 'nest-commander/src/constants';
import { IssueCommand } from './issue.command';
import { ConversationService } from '../integrations/ai/conversation/conversation.service';
import { LoggerService } from '../shared/logger/logger.service';
import { DryRunPreviewService } from '../shared/preview/dry-run-preview.service';
import { AgentOrchestrator } from '../agents/agent-orchestrator.service';
import { AiService } from '../integrations/ai/ai.service';
import * as os from 'os';
import * as path from 'path';

const mockCwd = '/tmp/consumer-app';

async function buildCommand(): Promise<IssueCommand> {
  const module = await Test.createTestingModule({
    providers: [
      IssueCommand,
      { provide: ConversationService, useValue: {} },
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
        provide: ConfigService,
        useValue: {
          get: jest.fn((key: string, defaultValue?: string) => {
            if (key === 'platforms.primary') return 'jira';
            if (key === 'ai.provider') return 'openai';
            return defaultValue;
          }),
        },
      },
      {
        provide: DryRunPreviewService,
        useValue: {
          showHeader: jest.fn(),
          showStageHeader: jest.fn(),
          showSummary: jest.fn(),
          showValidationResult: jest.fn(),
          showSkipped: jest.fn(),
          showNoSideEffects: jest.fn(),
          previewApiCall: jest.fn(),
          previewFileRead: jest.fn(),
          previewFileWrite: jest.fn(),
        },
      },
      { provide: AgentOrchestrator, useValue: {} },
      {
        provide: AiService,
        useValue: {
          getProviderDisplayName: jest.fn().mockReturnValue('OpenAI'),
        },
      },
    ],
  }).compile();

  return module.get(IssueCommand);
}

describe('IssueCommand', () => {
  let cwdSpy: jest.SpyInstance;

  beforeEach(() => {
    cwdSpy = jest.spyOn(process, 'cwd').mockReturnValue(mockCwd);
  });

  afterEach(() => {
    cwdSpy.mockRestore();
    jest.restoreAllMocks();
  });

  it('registers the command as issue', () => {
    const metadata = Reflect.getMetadata(CommandMeta, IssueCommand) as {
      name: string;
    };

    expect(metadata.name).toBe('issue');
  });

  it('stores default artifacts under the cwd namespace in dry-run mode', async () => {
    const command = await buildCommand();
    const dryRunPreview = (command as any)
      .dryRunPreview as jest.Mocked<DryRunPreviewService>;

    await command.run(['WBP-1'], {
      from: 'fetch',
      to: 'plan',
      action: 'fix',
      dryRun: true,
    });

    const fetchPreview = dryRunPreview.previewFileWrite.mock.calls[0][0];
    const planPreview = dryRunPreview.previewFileWrite.mock.calls[1][0];
    const expectedDir = path.join(os.homedir(), '.wf', 'consumer-app', 'jira');

    expect(path.dirname(fetchPreview.filePath)).toBe(expectedDir);
    expect(path.dirname(planPreview.filePath)).toBe(expectedDir);
  });

  it('stores repo-scoped artifacts under the targeted repo namespace in dry-run mode', async () => {
    const command = await buildCommand();
    const dryRunPreview = (command as any)
      .dryRunPreview as jest.Mocked<DryRunPreviewService>;

    await command.run(['WBP-1'], {
      from: 'fetch',
      to: 'plan',
      action: 'fix',
      repos: ['repo-a'],
      dryRun: true,
    });

    const fetchPreview = dryRunPreview.previewFileWrite.mock.calls[0][0];
    const planPreview = dryRunPreview.previewFileWrite.mock.calls[1][0];
    const expectedDir = path.join(os.homedir(), '.wf', 'repo-a', 'jira');

    expect(path.dirname(fetchPreview.filePath)).toBe(expectedDir);
    expect(path.dirname(planPreview.filePath)).toBe(expectedDir);
  });
});
