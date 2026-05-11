import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { HttpService } from '@nestjs/axios';
import { of, throwError } from 'rxjs';
import { JiraService } from './jira.service';
import { LoggerService } from '../../shared/logger/logger.service';
import { JiraApiError } from '../../shared/utils/errors';
import { PlatformConfigService } from '../platforms/platform-config.service';

describe('JiraService', () => {
  let service: JiraService;
  let httpService: HttpService;
  let configService: ConfigService;

  /**
   * Flatten ADF nodes so tests can assert the actual payload shape without
   * coupling to every surrounding block.
   *
   * @param node - ADF node, array, or primitive value to inspect
   * @returns A flat list of object nodes found in the input
   */
  const collectAdfNodes = (node: unknown): Array<Record<string, any>> => {
    if (!node || typeof node !== 'object') {
      return [];
    }

    if (Array.isArray(node)) {
      return node.flatMap(collectAdfNodes);
    }

    const objectNode = node as Record<string, any>;
    return [
      objectNode,
      ...Object.values(objectNode).flatMap((value) => collectAdfNodes(value)),
    ];
  };

  const mockConfigService = {
    get: jest.fn((key: string) => {
      const config: Record<string, any> = {
        'atlassian.baseUrl': 'https://test.atlassian.net',
        'atlassian.email': 'test@example.com',
        'atlassian.apiToken': 'test-token',
        'atlassian.jira.defaultProject': 'TEST',
      };
      return config[key];
    }),
  };

  const mockHttpService = {
    get: jest.fn(),
    post: jest.fn(),
    put: jest.fn(),
  };

  const mockLoggerService = {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    success: jest.fn(),
  };

  const mockPlatformConfigService = {
    isPlatformEnabled: jest.fn().mockReturnValue(true),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        JiraService,
        { provide: ConfigService, useValue: mockConfigService },
        { provide: HttpService, useValue: mockHttpService },
        { provide: LoggerService, useValue: mockLoggerService },
        {
          provide: PlatformConfigService,
          useValue: mockPlatformConfigService,
        },
      ],
    }).compile();

    service = module.get<JiraService>(JiraService);
    httpService = module.get<HttpService>(HttpService);
    configService = module.get<ConfigService>(ConfigService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('Markdown to ADF Conversion', () => {
    it('should convert simple text to ADF', () => {
      const markdown = 'Hello world';
      const adf = service.markdownToADF(markdown);

      expect(adf).toEqual({
        type: 'doc',
        version: 1,
        content: [
          {
            type: 'paragraph',
            content: [{ type: 'text', text: 'Hello world' }],
          },
        ],
      });
    });

    it('should convert headers to ADF', () => {
      const markdown = '# Heading 1\n## Heading 2';
      const adf = service.markdownToADF(markdown);

      expect(adf.content).toHaveLength(2);
      expect(adf.content[0]).toEqual({
        type: 'heading',
        attrs: { level: 1 },
        content: [{ type: 'text', text: 'Heading 1' }],
      });
      expect(adf.content[1]).toEqual({
        type: 'heading',
        attrs: { level: 2 },
        content: [{ type: 'text', text: 'Heading 2' }],
      });
    });

    it('should convert bold text to ADF', () => {
      const markdown = 'This is **bold** text';
      const adf = service.markdownToADF(markdown);

      expect(adf.content[0].content).toEqual([
        { type: 'text', text: 'This is ' },
        { type: 'text', text: 'bold', marks: [{ type: 'strong' }] },
        { type: 'text', text: ' text' },
      ]);
    });

    it('should convert italic text to ADF', () => {
      const markdown = 'This is *italic* text';
      const adf = service.markdownToADF(markdown);

      expect(adf.content[0].content).toEqual([
        { type: 'text', text: 'This is ' },
        { type: 'text', text: 'italic', marks: [{ type: 'em' }] },
        { type: 'text', text: ' text' },
      ]);
    });

    it('should convert inline code to ADF', () => {
      const markdown = 'Use `npm install` to install';
      const adf = service.markdownToADF(markdown);

      expect(adf.content[0].content).toEqual([
        { type: 'text', text: 'Use ' },
        { type: 'text', text: 'npm install', marks: [{ type: 'code' }] },
        { type: 'text', text: ' to install' },
      ]);
    });

    it('should convert code blocks to ADF', () => {
      const markdown = '```javascript\nconst x = 1;\n```';
      const adf = service.markdownToADF(markdown);

      expect(adf.content[0]).toEqual({
        type: 'codeBlock',
        attrs: { language: 'javascript' },
        content: [{ type: 'text', text: 'const x = 1;' }],
      });
    });

    it('should convert bullet lists to ADF', () => {
      const markdown = '- Item 1\n- Item 2\n- Item 3';
      const adf = service.markdownToADF(markdown);

      expect(adf.content[0].type).toBe('bulletList');
      expect(adf.content[0].content).toHaveLength(3);
    });

    it('should normalize indented star bullets to a Jira bullet list', () => {
      const markdown = '  * Item 1\n    * Item 2';
      const adf = service.markdownToADF(markdown);

      expect(adf.content[0].type).toBe('bulletList');
      expect(adf.content[0].content).toHaveLength(2);
      expect(adf.content[0].content[0].content[0].content).toEqual([
        { type: 'text', text: 'Item 1' },
      ]);
    });

    it('should convert ordered lists to ADF', () => {
      const markdown = '1. First\n2. Second\n3. Third';
      const adf = service.markdownToADF(markdown);

      expect(adf.content[0].type).toBe('orderedList');
      expect(adf.content[0].content).toHaveLength(3);
    });

    it('should normalize Jira wiki code fences to ADF code blocks', () => {
      const markdown = '{code:json}\n{\n  "id": "123"\n}\n{code}';
      const adf = service.markdownToADF(markdown);

      expect(adf.content[0]).toEqual({
        type: 'codeBlock',
        attrs: { language: 'json' },
        content: [{ type: 'text', text: '{\n  "id": "123"\n}' }],
      });
    });
  });

  describe('ADF to Markdown Conversion', () => {
    it('should convert simple ADF paragraph to markdown', () => {
      const adf = {
        type: 'doc',
        version: 1,
        content: [
          {
            type: 'paragraph',
            content: [{ type: 'text', text: 'Hello world' }],
          },
        ],
      };

      const markdown = service.adfToMarkdown(adf);
      expect(markdown.trim()).toBe('Hello world');
    });

    it('should convert ADF heading to markdown', () => {
      const adf = {
        type: 'doc',
        version: 1,
        content: [
          {
            type: 'heading',
            attrs: { level: 2 },
            content: [{ type: 'text', text: 'Heading' }],
          },
        ],
      };

      const markdown = service.adfToMarkdown(adf);
      expect(markdown.trim()).toBe('## Heading');
    });

    it('should convert ADF with bold text to markdown', () => {
      const adf = {
        type: 'doc',
        version: 1,
        content: [
          {
            type: 'paragraph',
            content: [
              { type: 'text', text: 'This is ' },
              { type: 'text', text: 'bold', marks: [{ type: 'strong' }] },
            ],
          },
        ],
      };

      const markdown = service.adfToMarkdown(adf);
      expect(markdown.trim()).toBe('This is **bold**');
    });

    it('should convert ADF bullet list to markdown', () => {
      const adf = {
        type: 'doc',
        version: 1,
        content: [
          {
            type: 'bulletList',
            content: [
              {
                type: 'listItem',
                content: [
                  {
                    type: 'paragraph',
                    content: [{ type: 'text', text: 'Item 1' }],
                  },
                ],
              },
              {
                type: 'listItem',
                content: [
                  {
                    type: 'paragraph',
                    content: [{ type: 'text', text: 'Item 2' }],
                  },
                ],
              },
            ],
          },
        ],
      };

      const markdown = service.adfToMarkdown(adf);
      expect(markdown.trim()).toBe('- Item 1\n- Item 2');
    });
  });

  describe('createTicket', () => {
    it('should build a create payload with adf code blocks and bullet lists', () => {
      const payload = service.buildCreatePayload({
        project: 'TEST',
        summary: 'Test issue',
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
        issueType: 'Bug',
        priority: 'High',
      });

      expect(payload).toEqual({
        fields: expect.objectContaining({
          project: { key: 'TEST' },
          summary: 'Test issue',
          issuetype: { name: 'Bug' },
          priority: { name: 'High' },
          description: expect.objectContaining({
            type: 'doc',
            version: 1,
            content: expect.arrayContaining([
              expect.objectContaining({ type: 'codeBlock' }),
              expect.objectContaining({ type: 'bulletList' }),
            ]),
          }),
        }),
      });
    });

    it('should create a ticket successfully', async () => {
      const mockResponse = {
        data: { key: 'TEST-123', id: '10001' },
      };

      mockHttpService.post.mockReturnValue(of(mockResponse));

      const request = {
        project: 'TEST',
        summary: 'Test issue',
        description: 'Test description',
        issueType: 'Bug',
      };

      const result = await service.createTicket(request);

      expect(result).toBe('TEST-123');
      expect(mockHttpService.post).toHaveBeenCalledWith(
        'https://test.atlassian.net/rest/api/3/issue',
        expect.objectContaining({
          fields: expect.objectContaining({
            project: { key: 'TEST' },
            summary: 'Test issue',
            issuetype: { name: 'Bug' },
          }),
        }),
        expect.any(Object),
      );
    });

    it('should post generated service-document markdown as Jira ADF', async () => {
      jest
        .spyOn(service, 'resolveValidPriorityName')
        .mockResolvedValue('Medium');
      mockHttpService.post.mockReturnValue(of({ data: { key: 'WBP-123' } }));

      await service.createTicket({
        project: 'WBP',
        summary: 'Create service document storage',
        description: [
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
          '- **Validation:** Reject missing service identifiers before writing.',
          '',
          '### Acceptance Criteria',
          '- Documents can be created from the API.',
          '- Invalid payloads return validation errors.',
          '',
          '### Unit Test Scope',
          '- DTO validation covers required fields.',
          '- Repository failures are surfaced clearly.',
        ].join('\n'),
        issueType: 'Story',
        priority: 'medium',
      });

      const payload = mockHttpService.post.mock.calls[0][1];
      const description = payload.fields.description;
      const adfNodes = collectAdfNodes(description);
      const serializedPayload = JSON.stringify(payload);
      const leakedBulletText = adfNodes.some(
        (node) =>
          node.type === 'text' &&
          typeof node.text === 'string' &&
          node.text.startsWith('- **Storage selection:**'),
      );
      const storageSelectionText = adfNodes.find(
        (node) => node.type === 'text' && node.text === 'Storage selection:',
      );

      expect(description.type).toBe('doc');
      expect(adfNodes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: 'heading' }),
          expect.objectContaining({ type: 'codeBlock' }),
          expect.objectContaining({ type: 'bulletList' }),
        ]),
      );
      expect(serializedPayload).not.toContain('{noformat}');
      expect(serializedPayload).not.toContain('{code}');
      expect(leakedBulletText).toBe(false);
      expect(storageSelectionText).toEqual(
        expect.objectContaining({
          marks: [{ type: 'strong' }],
        }),
      );
    });

    it('should throw error when Jira is not configured', async () => {
      const unconfiguredService = new JiraService(
        {
          get: jest.fn().mockReturnValue(undefined),
        } as any,
        httpService,
        mockLoggerService as any,
        mockPlatformConfigService as any,
      );

      await expect(
        unconfiguredService.createTicket({
          project: 'TEST',
          summary: 'Test',
          description: 'Test',
          issueType: 'Bug',
        }),
      ).rejects.toThrow(JiraApiError);
    });

    it('should handle 401 authentication error', async () => {
      mockHttpService.post.mockReturnValue(
        throwError(() => ({
          response: {
            status: 401,
            data: { errorMessages: ['Invalid credentials'] },
          },
        })),
      );

      await expect(
        service.createTicket({
          project: 'TEST',
          summary: 'Test',
          description: 'Test',
          issueType: 'Bug',
        }),
      ).rejects.toThrow('Authentication failed');
    });
  });

  describe('getTicket', () => {
    it('should fetch a ticket successfully', async () => {
      const mockResponse = {
        data: {
          key: 'TEST-123',
          id: '10001',
          fields: {
            summary: 'Test issue',
            description: {
              type: 'doc',
              version: 1,
              content: [
                {
                  type: 'paragraph',
                  content: [{ type: 'text', text: 'Test description' }],
                },
              ],
            },
            status: { name: 'Open' },
            issuetype: { name: 'Bug' },
            priority: { name: 'High' },
            assignee: { displayName: 'John Doe' },
            reporter: { displayName: 'Jane Doe' },
            created: '2024-01-01T10:00:00.000Z',
            updated: '2024-01-02T10:00:00.000Z',
            labels: ['bug', 'urgent'],
            components: [{ name: 'Backend' }],
          },
        },
      };

      mockHttpService.get.mockReturnValue(of(mockResponse));

      const result = await service.getTicket('TEST-123');

      expect(result.key).toBe('TEST-123');
      expect(result.summary).toBe('Test issue');
      expect(result.description.trim()).toBe('Test description');
      expect(result.status).toBe('Open');
      expect(result.issueType).toBe('Bug');
    });
  });

  describe('createTicket priority handling', () => {
    it('should resolve medium to Minor when create metadata allows Minor but not Medium', async () => {
      mockHttpService.get
        .mockReturnValueOnce(
          of({
            data: {
              issueTypes: [{ id: '10001', name: 'Task' }],
            },
          }),
        )
        .mockReturnValueOnce(
          of({
            data: {
              fields: {
                priority: {
                  allowedValues: [
                    { id: '1', name: 'Major' },
                    { id: '2', name: 'Minor' },
                    { id: '3', name: 'Trivial' },
                  ],
                },
              },
            },
          }),
        );
      mockHttpService.post.mockReturnValue(of({ data: { key: 'WBP-102' } }));

      const key = await service.createTicket({
        project: 'WBP',
        summary: 'Test ticket',
        description: 'desc',
        issueType: 'Task',
        priority: 'medium',
      });

      expect(key).toBe('WBP-102');
      const payload = mockHttpService.post.mock.calls[0][1];
      expect(payload.fields.priority).toEqual({ name: 'Minor' });
    });

    it('should prefer an exact allowed priority value over aliases', async () => {
      mockHttpService.get
        .mockReturnValueOnce(
          of({
            data: {
              issueTypes: [{ id: '10001', name: 'Task' }],
            },
          }),
        )
        .mockReturnValueOnce(
          of({
            data: {
              fields: {
                priority: {
                  allowedValues: [
                    { id: '1', name: 'Medium' },
                    { id: '2', name: 'Minor' },
                  ],
                },
              },
            },
          }),
        );
      mockHttpService.post.mockReturnValue(of({ data: { key: 'WBP-103' } }));

      const key = await service.createTicket({
        project: 'WBP',
        summary: 'Test ticket',
        description: 'desc',
        issueType: 'Task',
        priority: 'medium',
      });

      expect(key).toBe('WBP-103');
      const payload = mockHttpService.post.mock.calls[0][1];
      expect(payload.fields.priority).toEqual({ name: 'Medium' });
    });

    it('should omit priority when create metadata does not expose the priority field', async () => {
      mockHttpService.get
        .mockReturnValueOnce(
          of({
            data: {
              issueTypes: [{ id: '10001', name: 'Task' }],
            },
          }),
        )
        .mockReturnValueOnce(
          of({
            data: {
              fields: {},
            },
          }),
        );
      mockHttpService.post.mockReturnValue(of({ data: { key: 'WBP-104' } }));

      const key = await service.createTicket({
        project: 'WBP',
        summary: 'Test ticket',
        description: 'desc',
        issueType: 'Task',
        priority: 'medium',
      });

      expect(key).toBe('WBP-104');
      const payload = mockHttpService.post.mock.calls[0][1];
      expect(payload.fields.priority).toBeUndefined();
    });

    it('should omit priority when no matching priority name is found', async () => {
      // Priority lookup returns no match
      mockHttpService.get.mockReturnValue(
        of({
          data: [
            { id: '1', name: 'P1' },
            { id: '2', name: 'P2' },
          ],
        }),
      );
      // Create ticket succeeds
      mockHttpService.post.mockReturnValue(of({ data: { key: 'WBP-100' } }));

      const key = await service.createTicket({
        project: 'WBP',
        summary: 'Test ticket',
        description: 'desc',
        issueType: 'Task',
        priority: 'High',
      });

      expect(key).toBe('WBP-100');
      const payload = mockHttpService.post.mock.calls[0][1];
      expect(payload.fields.priority).toBeUndefined();
    });

    it('should include priority when the resolved name matches', async () => {
      // Priority lookup returns a match
      mockHttpService.get.mockReturnValue(
        of({
          data: [
            { id: '2', name: 'High' },
            { id: '3', name: 'Medium' },
          ],
        }),
      );
      mockHttpService.post.mockReturnValue(of({ data: { key: 'WBP-101' } }));

      const key = await service.createTicket({
        project: 'WBP',
        summary: 'Test ticket',
        description: 'desc',
        issueType: 'Task',
        priority: 'High',
      });

      expect(key).toBe('WBP-101');
      const payload = mockHttpService.post.mock.calls[0][1];
      expect(payload.fields.priority).toEqual({ name: 'High' });
    });

    it('should retry without priority when Jira rejects a resolved priority field', async () => {
      mockHttpService.get
        .mockReturnValueOnce(
          of({
            data: {
              issueTypes: [{ id: '10001', name: 'Task' }],
            },
          }),
        )
        .mockReturnValueOnce(
          of({
            data: {
              fields: {
                priority: {
                  allowedValues: [{ id: '3', name: 'Medium' }],
                },
              },
            },
          }),
        );

      mockHttpService.post
        .mockImplementationOnce(() =>
          throwError(() => ({
            response: {
              status: 400,
              data: { errors: { priority: 'Priority is not valid' } },
            },
          })),
        )
        .mockImplementationOnce((_url: string, payload: any) => {
          expect(payload.fields.priority).toBeUndefined();
          return of({ data: { key: 'WBP-200' } });
        });

      const key = await service.createTicket({
        project: 'WBP',
        summary: 'Test ticket',
        description: 'desc',
        issueType: 'Task',
        priority: 'Medium',
      });

      expect(key).toBe('WBP-200');
      expect(mockHttpService.post).toHaveBeenCalledTimes(2);
    });
  });

  describe('resolveValidPriorityName', () => {
    it('should return the exact Jira priority name when a case-insensitive match is found', async () => {
      mockHttpService.get.mockReturnValue(
        of({
          data: [
            { id: '1', name: 'Highest' },
            { id: '2', name: 'High' },
            { id: '3', name: 'Medium' },
            { id: '4', name: 'Low' },
            { id: '5', name: 'Lowest' },
          ],
        }),
      );

      const result = await service.resolveValidPriorityName('high');
      expect(result).toBe('High');
    });

    it('should return undefined when no matching priority exists', async () => {
      mockHttpService.get.mockReturnValue(
        of({
          data: [
            { id: '1', name: 'P1' },
            { id: '2', name: 'P2' },
            { id: '3', name: 'P3' },
          ],
        }),
      );

      const result = await service.resolveValidPriorityName('High');
      expect(result).toBeUndefined();
    });

    it('should return undefined when the priority fetch fails', async () => {
      mockHttpService.get.mockReturnValue(
        throwError(() => new Error('Network error')),
      );

      const result = await service.resolveValidPriorityName('High');
      expect(result).toBeUndefined();
    });
  });
});
