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
import { JiraAdapter } from '../integrations/platforms/jira/jira-adapter';
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
  description: [
    '### Summary',
    'Generated summary',
    '',
    '```json',
    '{',
    '  "id": "123"',
    '}',
    '```',
    '',
    '### Acceptance Criteria',
    '- First item',
  ].join('\n'),
};

async function buildCommand(): Promise<IssueCreateCommand> {
  const mockPlatformAdapter = {
    createTicket: jest.fn().mockResolvedValue({
      platform: 'jira',
      key: 'WBP-123',
      id: 'WBP-123',
      url: 'https://test.atlassian.net/browse/WBP-123',
    }),
  };
  const mockPlatformService = {
    getAdapter: jest.fn().mockReturnValue(mockPlatformAdapter),
  };

  const module = await Test.createTestingModule({
    providers: [
      IssueCreateCommand,
      { provide: PlatformService, useValue: mockPlatformService },
      {
        provide: JiraAdapter,
        useValue: {
          buildCreatePayload: jest.fn((ticket) => ({
            fields: {
              project: { key: ticket.project || 'WBP' },
              summary: ticket.title,
              description: {
                type: 'doc',
                version: 1,
                content: [
                  {
                    type: 'codeBlock',
                    attrs: { language: 'json' },
                    content: [{ type: 'text', text: '{\n  "id": "123"\n}' }],
                  },
                  {
                    type: 'bulletList',
                    content: [
                      {
                        type: 'listItem',
                        content: [
                          {
                            type: 'paragraph',
                            content: [{ type: 'text', text: 'First item' }],
                          },
                        ],
                      },
                    ],
                  },
                ],
              },
            },
          })),
        },
      },
      {
        provide: FormatConverterService,
        useValue: {
          detectFormat: jest.fn().mockReturnValue('md'),
          getConverter: jest.fn().mockReturnValue({
            parse: jest.fn((content: string) => {
              if (!content.includes('Create service document storage')) {
                return { ...mockTicket };
              }

              const description = content
                .split(/^## Description$/m)
                .slice(1)
                .join('## Description')
                .trim();

              return {
                ...mockTicket,
                title: 'Create service document storage',
                type: 'story',
                priority: 'medium',
                description,
              };
            }),
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

  it('previews the transformed Jira payload during dry runs', async () => {
    const command = await buildCommand();
    const dryRunPreview = (command as any)
      .dryRunPreview as jest.Mocked<DryRunPreviewService>;
    const jiraAdapter = (command as any).jiraAdapter as {
      buildCreatePayload: jest.Mock;
    };
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

    expect(jiraAdapter.buildCreatePayload).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Generated ticket',
      }),
    );
    expect(dryRunPreview.previewApiCall).toHaveBeenCalledWith(
      expect.objectContaining({
        payloadPreviewLines: expect.arrayContaining([
          'Formatting Summary',
          '  Code blocks: 1',
          '  Bullet lists: 1',
          '  Suspicious raw markers: none',
          'Ticket Preview',
          '  ### Summary',
          '  Generated summary',
          '  ```json',
          '  ### Acceptance Criteria',
          '  - First item',
        ]),
      }),
    );
  });

  it('creates a Jira ticket from a repo-scoped generated artifact path', async () => {
    const command = await buildCommand();
    const platformService = (command as any)
      .platformService as jest.Mocked<PlatformService>;
    const artifactPath = path.join(
      os.homedir(),
      '.wf',
      'service-document-v1',
      'jira',
      '2026-05-05-d22a1c03-ticket-description.md',
    );
    const artifactContent = [
      '# Create service document storage',
      '',
      '**Type:** story',
      '**Priority:** medium',
      '',
      '## Description',
      '### Summary',
      'Create a persisted service document flow.',
      '',
      '```typescript',
      'export class CreateServiceDocumentDto {',
      '  serviceId: string;',
      '}',
      '```',
      '',
      '### Technical Details',
      '- **Storage selection:** Persist documents in the existing service document namespace.',
      '',
      '### Acceptance Criteria',
      '- Documents can be created from the API.',
      '',
      '### Unit Test Scope',
      '- DTO validation covers required fields.',
    ].join('\n');

    mockExistsSync.mockImplementation(
      (input) => String(input) === artifactPath,
    );
    mockReadFileSync.mockReturnValue(artifactContent);

    await command.run(['2026-05-05-d22a1c03-ticket-description.md'], {
      repos: ['service-document-v1'],
      ticketProject: 'WBP',
    });

    expect(mockReadFileSync).toHaveBeenCalledWith(artifactPath, 'utf-8');
    expect(platformService.getAdapter).toHaveBeenCalledWith('jira');
    const mockAdapter = (platformService.getAdapter as jest.Mock).mock
      .results[0].value as {
      createTicket: jest.Mock;
    };
    expect(mockAdapter.createTicket).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Create service document storage',
        project: 'WBP',
        description: expect.stringContaining(
          '- **Storage selection:** Persist documents',
        ),
      }),
    );
  });
});
