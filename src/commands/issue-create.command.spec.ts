// Mock chalk before any imports
jest.mock('chalk', () => {
  const identity = (value: any) => value;
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
import { IssueCreateCommand } from './issue-create.command';
import { PlatformService } from '../integrations/platforms/platform.service';
import { FormatConverterService } from '../common/converters/format-converter.service';
import { LoggerService } from '../shared/logger/logger.service';
import { DryRunPreviewService } from '../shared/preview/dry-run-preview.service';
import { ErrorHandler } from '../shared/utils/error-handler';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

jest.mock('fs', () => ({
  existsSync: jest.fn(),
  readFileSync: jest.fn(),
}));

const mockCwd = '/tmp/consumer-app';

const mockTicket = {
  title: 'Generated ticket',
  type: 'story',
  priority: 'medium',
  project: 'WBP',
};

async function buildCommand(): Promise<IssueCreateCommand> {
  const module = await Test.createTestingModule({
    providers: [
      IssueCreateCommand,
      { provide: PlatformService, useValue: {} },
      {
        provide: FormatConverterService,
        useValue: {
          detectFormat: jest.fn().mockReturnValue('md'),
          getConverter: jest.fn().mockReturnValue({
            parse: jest.fn().mockReturnValue({ ...mockTicket }),
          }),
        },
      },
      {
        provide: ConfigService,
        useValue: {
          get: jest.fn((key: string, defaultValue?: string) => {
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
        },
      },
    ],
  }).compile();

  return module.get(IssueCreateCommand);
}

describe('IssueCreateCommand', () => {
  let cwdSpy: jest.SpyInstance;
  let handleErrorSpy: jest.SpyInstance;
  const mockExistsSync = fs.existsSync as jest.MockedFunction<
    typeof fs.existsSync
  >;
  const mockReadFileSync = fs.readFileSync as jest.MockedFunction<
    typeof fs.readFileSync
  >;

  beforeEach(() => {
    cwdSpy = jest.spyOn(process, 'cwd').mockReturnValue(mockCwd);
    handleErrorSpy = jest
      .spyOn(ErrorHandler, 'handle')
      .mockImplementation((error: Error) => {
        throw error;
      });
    mockExistsSync.mockReset();
    mockReadFileSync.mockReset();
    mockReadFileSync.mockReturnValue('# Generated ticket');
  });

  afterEach(() => {
    cwdSpy.mockRestore();
    handleErrorSpy.mockRestore();
    jest.restoreAllMocks();
  });

  it('resolves filename-only input under the cwd artifact namespace by default', async () => {
    const command = await buildCommand();
    const dryRunPreview = (command as any)
      .dryRunPreview as jest.Mocked<DryRunPreviewService>;
    const artifactPath = path.join(
      os.homedir(),
      '.wf',
      'consumer-app',
      'jira',
      'GENERATED-2026-04-01-46ac9014.md',
    );

    mockExistsSync.mockImplementation(
      (input) => String(input) === artifactPath,
    );

    await command.run(['GENERATED-2026-04-01-46ac9014.md'], {
      dryRun: true,
    });

    expect(mockReadFileSync).toHaveBeenCalledWith(artifactPath, 'utf-8');
    expect(dryRunPreview.showValidationResult).toHaveBeenCalled();
  });

  it('resolves filename-only input under the targeted repo namespace when --repos is provided', async () => {
    const command = await buildCommand();
    const artifactPath = path.join(
      os.homedir(),
      '.wf',
      'repo-a',
      'jira',
      'GENERATED-2026-04-01-46ac9014.md',
    );

    mockExistsSync.mockImplementation(
      (input) => String(input) === artifactPath,
    );

    await command.run(['GENERATED-2026-04-01-46ac9014.md'], {
      repos: ['repo-a'],
      dryRun: true,
    });

    expect(mockReadFileSync).toHaveBeenCalledWith(artifactPath, 'utf-8');
  });

  it('prefers an explicit local path over the artifact namespace', async () => {
    const command = await buildCommand();
    const explicitPath = path.join('/tmp', 'GENERATED-2026-04-01-46ac9014.md');

    mockExistsSync.mockImplementation(
      (input) => String(input) === explicitPath,
    );

    await command.run([explicitPath], {
      dryRun: true,
    });

    expect(mockReadFileSync).toHaveBeenCalledWith(explicitPath, 'utf-8');
  });

  it('does not fall back to the bare ~/.wf filename path', async () => {
    const command = await buildCommand();
    const expectedMissingPath = path.resolve(
      'GENERATED-2026-04-01-46ac9014.md',
    );
    const bareWfPath = path.join(
      os.homedir(),
      '.wf',
      'GENERATED-2026-04-01-46ac9014.md',
    );

    mockExistsSync.mockImplementation((input) => String(input) === bareWfPath);

    await expect(
      command.run(['GENERATED-2026-04-01-46ac9014.md'], {
        dryRun: true,
      }),
    ).rejects.toThrow(`Input file not found: ${expectedMissingPath}`);
    expect(mockReadFileSync).not.toHaveBeenCalled();
  });

  it('warns and uses only the first repo namespace when multiple repos are provided', async () => {
    const command = await buildCommand();
    const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    const artifactPath = path.join(
      os.homedir(),
      '.wf',
      'repo-a',
      'jira',
      'GENERATED-2026-04-01-46ac9014.md',
    );

    mockExistsSync.mockImplementation(
      (input) => String(input) === artifactPath,
    );

    await command.run(['GENERATED-2026-04-01-46ac9014.md'], {
      repos: ['repo-a', 'repo-b'],
      dryRun: true,
    });

    expect(mockReadFileSync).toHaveBeenCalledWith(artifactPath, 'utf-8');
    expect(
      consoleSpy.mock.calls.some((call) =>
        String(call[0]).includes('Only the first repository'),
      ),
    ).toBe(true);

    consoleSpy.mockRestore();
  });
});
