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

    it('should convert ordered lists to ADF', () => {
      const markdown = '1. First\n2. Second\n3. Third';
      const adf = service.markdownToADF(markdown);

      expect(adf.content[0].type).toBe('orderedList');
      expect(adf.content[0].content).toHaveLength(3);
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
});
