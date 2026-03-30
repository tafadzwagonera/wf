import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { JiraAdapter } from './jira-adapter';
import { JiraService } from '../../jira/jira.service';

describe('JiraAdapter', () => {
  let adapter: JiraAdapter;

  const mockJiraService = {
    createTicket: jest.fn(),
    getTicket: jest.fn(),
    updateTicket: jest.fn(),
    searchTickets: jest.fn(),
  };

  const mockConfigService = {
    get: jest.fn((key: string) => {
      if (key === 'atlassian.baseUrl') return 'https://mycompany.atlassian.net';
      return undefined;
    }),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        JiraAdapter,
        { provide: JiraService, useValue: mockJiraService },
        { provide: ConfigService, useValue: mockConfigService },
      ],
    }).compile();

    adapter = module.get<JiraAdapter>(JiraAdapter);
  });

  afterEach(() => jest.clearAllMocks());

  describe('createTicket URL', () => {
    it('should build the ticket URL from ATLASSIAN_BASE_URL', async () => {
      mockJiraService.createTicket.mockResolvedValue('WBP-999');

      const ref = await adapter.createTicket({
        project: 'WBP',
        title: 'Test',
        description: 'desc',
      } as any);

      expect(ref.url).toBe('https://mycompany.atlassian.net/browse/WBP-999');
    });

    it('should fall back to empty string when ATLASSIAN_BASE_URL is not set', async () => {
      mockConfigService.get.mockReturnValue(undefined);
      mockJiraService.createTicket.mockResolvedValue('WBP-998');

      const ref = await adapter.createTicket({
        project: 'WBP',
        title: 'Test',
        description: 'desc',
      } as any);

      expect(ref.url).toBe('/browse/WBP-998');
    });
  });
});
