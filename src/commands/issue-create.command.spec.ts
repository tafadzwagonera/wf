// Mock chalk before any imports
jest.mock('chalk', () => {
  const identity = (value: any) => value;
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
import { IssueTrackerService } from '../integrations/issue-trackers/issue-tracker.service';
import { FormatConverterService } from '../common/converters/format-converter.service';
import { LoggerService } from '../shared/logger/logger.service';
import { DryRunPreviewService } from '../shared/preview/dry-run-preview.service';
import { ErrorHandler } from '../shared/utils/error-handler';
import { JiraAdapter } from '../integrations/issue-trackers/jira/jira-adapter';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { getWfHomeDir } from '../shared/utils/wf-paths';

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
  const mockIssueTrackerAdapter = {
    createTicket: jest.fn().mockResolvedValue({
      tracker: 'jira',
      key: 'WBP-123',
      id: 'WBP-123',
      url: 'https://test.atlassian.net/browse/WBP-123',
    }),
  };
  const mockIssueTrackerService = {
    getAdapter: jest.fn().mockReturnValue(mockIssueTrackerAdapter),
  };

  const module = await Test.createTestingModule({
    providers: [
      IssueCreateCommand,
      { provide: IssueTrackerService, useValue: mockIssueTrackerService },
      {
        provide: JiraAdapter,
        useValue: {
          buildCreatePayload: jest.fn(ticket => ({
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
              if (!content.includes('## Description')) {
                return { ...mockTicket };
              }

              const titleMatch = /^# (.+)$/m.exec(content);
              const title = titleMatch ? titleMatch[1] : mockTicket.title;

              const description = content
                .split(/^## Description$/m)
                .slice(1)
                .join('## Description')
                .trim();

              return {
                ...mockTicket,
                title,
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
        },
      },
    ],
  }).compile();

  return module.get(IssueCreateCommand);
}

describe('IssueCreateCommand', () => {
  let cwdSpy: jest.SpyInstance;
  let handleErrorSpy: jest.SpyInstance;
  const mockExistsSync = fs.existsSync as jest.MockedFunction<typeof fs.existsSync>;
  const mockReadFileSync = fs.readFileSync as jest.MockedFunction<typeof fs.readFileSync>;

  beforeEach(() => {
    cwdSpy = jest.spyOn(process, 'cwd').mockReturnValue(mockCwd);
    handleErrorSpy = jest.spyOn(ErrorHandler, 'handle').mockImplementation((error: Error) => {
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
    const dryRunPreview = (command as any).dryRunPreview as jest.Mocked<DryRunPreviewService>;
    const artifactPath = path.join(getWfHomeDir(), 'consumer-app', 'jira', '2026-04-01-46ac9014-ticket-description.md');

    mockExistsSync.mockImplementation(input => String(input) === artifactPath);

    await command.run(['2026-04-01-46ac9014-ticket-description.md'], {
      dryRun: true,
    });

    expect(mockReadFileSync).toHaveBeenCalledWith(artifactPath, 'utf-8');
    expect(dryRunPreview.showValidationResult).toHaveBeenCalled();
  });

  it('resolves filename-only input under the targeted repo namespace when --repos is provided', async () => {
    const command = await buildCommand();
    const artifactPath = path.join(getWfHomeDir(), 'repo-a', 'jira', '2026-04-01-46ac9014-ticket-description.md');

    mockExistsSync.mockImplementation(input => String(input) === artifactPath);

    await command.run(['2026-04-01-46ac9014-ticket-description.md'], {
      repos: ['repo-a'],
      dryRun: true,
    });

    expect(mockReadFileSync).toHaveBeenCalledWith(artifactPath, 'utf-8');
  });

  it('prefers an explicit local path over the artifact namespace', async () => {
    const command = await buildCommand();
    const explicitPath = path.join('/tmp', '2026-04-01-46ac9014-ticket-description.md');

    mockExistsSync.mockImplementation(input => String(input) === explicitPath);

    await command.run([explicitPath], {
      dryRun: true,
    });

    expect(mockReadFileSync).toHaveBeenCalledWith(explicitPath, 'utf-8');
  });

  it('does not fall back to the bare ~/.wf filename path', async () => {
    const command = await buildCommand();
    const expectedMissingPath = path.join(getWfHomeDir(), 'consumer-app', 'jira', '2026-04-01-46ac9014-ticket-description.md');
    const bareWfPath = path.join(getWfHomeDir(), '2026-04-01-46ac9014-ticket-description.md');

    mockExistsSync.mockImplementation(input => String(input) === bareWfPath);

    await expect(
      command.run(['2026-04-01-46ac9014-ticket-description.md'], {
        dryRun: true,
      }),
    ).rejects.toThrow(`Input file not found: ${expectedMissingPath}`);
    expect(mockReadFileSync).not.toHaveBeenCalled();
  });

  it('warns and uses only the first repo namespace when multiple repos are provided', async () => {
    const command = await buildCommand();
    const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    const artifactPath = path.join(getWfHomeDir(), 'repo-a', 'jira', '2026-04-01-46ac9014-ticket-description.md');

    mockExistsSync.mockImplementation(input => String(input) === artifactPath);

    await command.run(['2026-04-01-46ac9014-ticket-description.md'], {
      repos: ['repo-a', 'repo-b'],
      dryRun: true,
    });

    expect(mockReadFileSync).toHaveBeenCalledWith(artifactPath, 'utf-8');
    expect(consoleSpy.mock.calls.some(call => String(call[0]).includes('Only the first repository'))).toBe(true);

    consoleSpy.mockRestore();
  });

  it('previews the transformed Jira payload during dry runs', async () => {
    const command = await buildCommand();
    const dryRunPreview = (command as any).dryRunPreview as jest.Mocked<DryRunPreviewService>;
    const jiraAdapter = (command as any).jiraAdapter as {
      buildCreatePayload: jest.Mock;
    };
    const artifactPath = path.join(getWfHomeDir(), 'consumer-app', 'jira', '2026-04-01-46ac9014-ticket-description.md');

    mockExistsSync.mockImplementation(input => String(input) === artifactPath);

    await command.run(['2026-04-01-46ac9014-ticket-description.md'], {
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
    const issueTrackerService = (command as any).issueTrackerService as jest.Mocked<IssueTrackerService>;
    const artifactPath = path.join(
      getWfHomeDir(), 'service-document-v1',
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
    ].join('\n');

    mockExistsSync.mockImplementation(input => String(input) === artifactPath);
    mockReadFileSync.mockReturnValue(artifactContent);

    await command.run(['2026-05-05-d22a1c03-ticket-description.md'], {
      repos: ['service-document-v1'],
      ticketProject: 'WBP',
    });

    expect(mockReadFileSync).toHaveBeenCalledWith(artifactPath, 'utf-8');
    expect(issueTrackerService.getAdapter).toHaveBeenCalledWith('jira');
    const mockAdapter = (issueTrackerService.getAdapter as jest.Mock).mock.results[0].value as {
      createTicket: jest.Mock;
    };
    expect(mockAdapter.createTicket).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Create service document storage',
        project: 'WBP',
        description: expect.stringContaining('- **Storage selection:** Persist documents'),
      }),
    );
  });

  it('treats Jira markdown with headings and bullets as safe without requiring code blocks', async () => {
    const command = await buildCommand();
    const dryRunPreview = (command as any).dryRunPreview as jest.Mocked<DryRunPreviewService>;
    const jiraAdapter = (command as any).jiraAdapter as {
      buildCreatePayload: jest.Mock;
    };
    const artifactPath = path.join(
      getWfHomeDir(), 'terraform-aws',
      'jira',
      '2026-05-12-d38b5be9-ticket-description.md',
    );
    const artifactContent = [
      '# Fix `service-document` startup failures',
      '',
      '**Type:** bug',
      '**Priority:** low',
      '',
      '## Description',
      '### Summary',
      '',
      'The `service-document` ECS task fails during startup.',
      '',
      '#### Technical Details',
      '',
      '- Increase the ECS service `health_check_grace_period_seconds`.',
    ].join('\n');

    mockExistsSync.mockImplementation(input => String(input) === artifactPath);
    mockReadFileSync.mockReturnValue(artifactContent);
    jiraAdapter.buildCreatePayload.mockReturnValueOnce({
      fields: {
        description: {
          type: 'doc',
          version: 1,
          content: [
            {
              type: 'heading',
              attrs: { level: 3 },
              content: [{ type: 'text', text: 'Summary' }],
            },
            {
              type: 'bulletList',
              content: [
                {
                  type: 'listItem',
                  content: [
                    {
                      type: 'paragraph',
                      content: [
                        {
                          type: 'text',
                          text: 'Increase the ECS service health_check_grace_period_seconds.',
                        },
                      ],
                    },
                  ],
                },
              ],
            },
          ],
        },
      },
    });

    await command.run(['2026-05-12-d38b5be9-ticket-description.md'], {
      repos: ['terraform-aws'],
      dryRun: true,
    });

    expect(dryRunPreview.previewApiCall).toHaveBeenCalledWith(
      expect.objectContaining({
        payloadPreviewLines: expect.arrayContaining([
          '  Code blocks: 0',
          '  Bullet lists: 1',
          '  Suspicious raw markers: none',
          '  Verdict: looks Jira-safe',
        ]),
      }),
    );
  });

  it('strips removed sections from the ticket description before creating', async () => {
    const command = await buildCommand();
    const issueTrackerService = (command as any).issueTrackerService as jest.Mocked<IssueTrackerService>;
    const artifactPath = path.join(getWfHomeDir(), 'service-document-v1', 'jira', '2026-06-19-strip-test.md');
    const artifactContent = [
      '# Strip sections test',
      '',
      '**Type:** story',
      '**Priority:** medium',
      '',
      '## Description',
      '### Summary',
      'A service document flow.',
      '',
      '### Acceptance Criteria',
      '- Documents can be created.',
      '',
      '### Unit Test Scope',
      '- DTO validation covers required fields.',
      '',
      '#### Dependencies',
      '- service-auth v2',
      '',
      '### Risks & Assumptions',
      '- None',
      '',
      '### Affected Repositories',
      '- service-document-v1',
      '',
      '#### References',
      '- https://example.com/doc',
      '- Internal wiki link',
      '',
      '#### Out of Scope',
      '- Refund handling',
    ].join('\n');

    mockExistsSync.mockImplementation(input => String(input) === artifactPath);
    mockReadFileSync.mockReturnValue(artifactContent);

    await command.run(['2026-06-19-strip-test.md'], {
      repos: ['service-document-v1'],
      ticketProject: 'WBP',
    });

    const mockAdapter = (issueTrackerService.getAdapter as jest.Mock).mock.results[0].value as {
      createTicket: jest.Mock;
    };
    const ticket = mockAdapter.createTicket.mock.calls[0][0];
    expect(ticket.description).not.toContain('#### References');
    expect(ticket.description).not.toContain('https://example.com/doc');
    expect(ticket.description).not.toContain('### Unit Test Scope');
    expect(ticket.description).not.toContain('#### Dependencies');
    expect(ticket.description).not.toContain('### Affected Repositories');
    expect(ticket.description).not.toContain('### Risks & Assumptions');
    expect(ticket.description).toContain('### Acceptance Criteria');
    expect(ticket.description).toContain('#### Out of Scope');
  });

  it('passes normalized command priority and ticket project to the Jira adapter', async () => {
    const command = await buildCommand();
    const issueTrackerService = (command as any).issueTrackerService as jest.Mocked<IssueTrackerService>;
    const artifactPath = path.join(getWfHomeDir(), 'consumer-app', 'jira', '2026-04-01-46ac9014-ticket-description.md');

    mockExistsSync.mockImplementation(input => String(input) === artifactPath);

    await command.run(['2026-04-01-46ac9014-ticket-description.md'], {
      priority: 'medium',
      ticketProject: 'WBP',
      tracker: 'jira',
    });

    const mockAdapter = (issueTrackerService.getAdapter as jest.Mock).mock.results[0].value as {
      createTicket: jest.Mock;
    };
    expect(mockAdapter.createTicket).toHaveBeenCalledWith(
      expect.objectContaining({
        priority: 'medium',
        project: 'WBP',
      }),
    );
  });
});
