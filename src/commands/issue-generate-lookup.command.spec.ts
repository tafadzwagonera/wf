jest.mock('chalk', () => {
  const identity = (s: any) => s;
  const makeChain = () => {
    const chain: any = identity;
    for (const name of [
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
    ]) {
      chain[name] = identity;
    }
    return chain;
  };
  const chalk = makeChain();
  chalk.bold = makeChain();
  return { default: chalk, ...chalk };
});

jest.mock('fs', () => {
  const actual = jest.requireActual('fs');
  return {
    ...actual,
    existsSync: jest.fn(actual.existsSync),
    readdirSync: jest.fn(actual.readdirSync),
    readFileSync: jest.fn(actual.readFileSync),
  };
});

import { Test } from '@nestjs/testing';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { ConfigService } from '@nestjs/config';
import { LoggerService } from '../common/logger/logger.service';
import { DryRunPreviewService } from '../common/preview/dry-run-preview.service';
import { IssueGenerateLookupCommand } from './issue-generate-lookup.command';
import { getWfHomeDir } from '../common/utils/wf-paths';

describe('IssueGenerateLookupCommand', () => {
  let cwdSpy: jest.SpyInstance;
  let consoleLogSpy: jest.SpyInstance;
  let consoleErrorSpy: jest.SpyInstance;

  beforeEach(() => {
    cwdSpy = jest.spyOn(process, 'cwd').mockReturnValue('/tmp/consumer-app');
    consoleLogSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    cwdSpy.mockRestore();
    consoleLogSpy.mockRestore();
    consoleErrorSpy.mockRestore();
    jest.restoreAllMocks();
  });

  it('prints the stored source list for a matching token', async () => {
    const module = await Test.createTestingModule({
      providers: [
        IssueGenerateLookupCommand,
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

    const command = module.get(IssueGenerateLookupCommand);
    const artifactDir = path.join(getWfHomeDir(), 'consumer-app', 'jira');

    (fs.existsSync as jest.MockedFunction<typeof fs.existsSync>).mockReturnValue(true);
    (fs.readdirSync as jest.MockedFunction<typeof fs.readdirSync>).mockReturnValue([
      '2026-04-16-1a2b3c4d-ticket-description.sources.json',
    ] as any);
    (fs.readFileSync as jest.MockedFunction<typeof fs.readFileSync>).mockReturnValue(
      JSON.stringify({
        artifactPath: path.join(artifactDir, '2026-04-16-1a2b3c4d-ticket-description.md'),
        createdAt: '2026-04-16T00:00:00.000Z',
        hash: '1a2b3c4d',
        sources: ['https://example.com/spec', './notes.md'],
      }),
    );

    await command.run(['1a2b3c4d']);

    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('https://example.com/spec'));
    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('./notes.md'));
  });

  it('suppresses the header when --silent is passed', async () => {
    const module = await Test.createTestingModule({
      providers: [
        IssueGenerateLookupCommand,
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
          useValue: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), success: jest.fn() },
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

    const command = module.get(IssueGenerateLookupCommand);
    const artifactDir = path.join(getWfHomeDir(), 'consumer-app', 'jira');

    (fs.existsSync as jest.MockedFunction<typeof fs.existsSync>).mockReturnValue(true);
    (fs.readdirSync as jest.MockedFunction<typeof fs.readdirSync>).mockReturnValue([
      '2026-04-16-1a2b3c4d-ticket-description.sources.json',
    ] as any);
    (fs.readFileSync as jest.MockedFunction<typeof fs.readFileSync>).mockReturnValue(
      JSON.stringify({
        artifactPath: path.join(artifactDir, '2026-04-16-1a2b3c4d-ticket-description.md'),
        createdAt: '2026-04-16T00:00:00.000Z',
        hash: '1a2b3c4d',
        sources: ['https://example.com/spec'],
      }),
    );

    consoleLogSpy.mockRestore();
    const silentSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

    await command.run(['1a2b3c4d'], { silent: true });

    const allOutput = silentSpy.mock.calls.map(call => String(call[0])).join('\n');
    expect(allOutput).not.toContain('Lookup the original source list for a generated ticket artifact hash.');
    expect(allOutput).not.toContain('Examples:');

    silentSpy.mockRestore();
  });

  it('rejects truncated hash with FileSystemError', async () => {
    const module = await Test.createTestingModule({
      providers: [
        IssueGenerateLookupCommand,
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
          useValue: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), success: jest.fn() },
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

    const command = module.get(IssueGenerateLookupCommand);

    (fs.existsSync as jest.MockedFunction<typeof fs.existsSync>).mockReturnValue(true);
    (fs.readdirSync as jest.MockedFunction<typeof fs.readdirSync>).mockReturnValue([
      '2026-04-16-1a2b3c4d-ticket-description.sources.json',
    ] as any);
    (fs.readFileSync as jest.MockedFunction<typeof fs.readFileSync>).mockReturnValue(
      JSON.stringify({
        artifactPath: '/tmp/2026-04-16-1a2b3c4d-ticket-description.md',
        createdAt: '2026-04-16T00:00:00.000Z',
        hash: '1a2b3c4d',
        sources: ['https://example.com/spec'],
      }),
    );

    const exitSpy = jest.spyOn(process, 'exit').mockImplementation((() => undefined) as never);

    await command.run(['1a2b']);

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(consoleErrorSpy).toHaveBeenCalled();

    exitSpy.mockRestore();
  });

  it('rejects filename fragment with FileSystemError', async () => {
    const module = await Test.createTestingModule({
      providers: [
        IssueGenerateLookupCommand,
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
          useValue: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), success: jest.fn() },
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

    const command = module.get(IssueGenerateLookupCommand);

    (fs.existsSync as jest.MockedFunction<typeof fs.existsSync>).mockReturnValue(true);
    (fs.readdirSync as jest.MockedFunction<typeof fs.readdirSync>).mockReturnValue([
      '2026-04-16-1a2b3c4d-ticket-description.sources.json',
    ] as any);
    (fs.readFileSync as jest.MockedFunction<typeof fs.readFileSync>).mockReturnValue(
      JSON.stringify({
        artifactPath: '/tmp/2026-04-16-1a2b3c4d-ticket-description.md',
        createdAt: '2026-04-16T00:00:00.000Z',
        hash: '1a2b3c4d',
        sources: ['https://example.com/spec'],
      }),
    );

    const exitSpy = jest.spyOn(process, 'exit').mockImplementation((() => undefined) as never);

    await command.run(['ticket']);

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(consoleErrorSpy).toHaveBeenCalled();

    exitSpy.mockRestore();
  });

  it('resolves uppercase full hash', async () => {
    const module = await Test.createTestingModule({
      providers: [
        IssueGenerateLookupCommand,
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
          useValue: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), success: jest.fn() },
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

    const command = module.get(IssueGenerateLookupCommand);

    (fs.existsSync as jest.MockedFunction<typeof fs.existsSync>).mockReturnValue(true);
    (fs.readdirSync as jest.MockedFunction<typeof fs.readdirSync>).mockReturnValue([
      '2026-04-16-1a2b3c4d-ticket-description.sources.json',
    ] as any);
    (fs.readFileSync as jest.MockedFunction<typeof fs.readFileSync>).mockReturnValue(
      JSON.stringify({
        artifactPath: '/tmp/2026-04-16-1a2b3c4d-ticket-description.md',
        createdAt: '2026-04-16T00:00:00.000Z',
        hash: '1a2b3c4d',
        sources: ['https://example.com/spec'],
      }),
    );

    await command.run(['1A2B3C4D']);

    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('https://example.com/spec'));
  });
});
