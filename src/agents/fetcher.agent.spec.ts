import { Test } from '@nestjs/testing';
import { FetcherAgent } from './fetcher.agent';
import { FetchStageService } from '../workflows/stages/fetch-stage.service';

describe('FetcherAgent', () => {
  let agent: FetcherAgent;
  let fetchStageService: { fetchArtifact: jest.Mock; loadArtifact: jest.Mock };
  let mockConsoleLog: jest.SpyInstance;

  beforeEach(async () => {
    fetchStageService = {
      fetchArtifact: jest.fn(),
      loadArtifact: jest.fn(),
    };

    const module = await Test.createTestingModule({
      providers: [FetcherAgent, { provide: FetchStageService, useValue: fetchStageService }],
    }).compile();

    agent = module.get(FetcherAgent);
    mockConsoleLog = jest.spyOn(console, 'log').mockImplementation();
  });

  afterEach(() => {
    mockConsoleLog.mockRestore();
  });

  describe('execute', () => {
    it('delegates artifact fetching to FetchStageService', async () => {
      fetchStageService.fetchArtifact.mockResolvedValue({
        ticketKey: 'WBP-123',
        content: '# WBP-123: Fix auth flow',
        path: '/tmp/.wf/repo/jira/WBP-123.md',
      });

      await agent.execute('WBP-123', {
        trackerName: 'jira',
        baseDir: '/tmp/repo',
      });

      expect(fetchStageService.fetchArtifact).toHaveBeenCalledWith('WBP-123', {
        trackerName: 'jira',
        baseDir: '/tmp/repo',
      });
    });

    it('logs cached artifact warning when fromCache is true', async () => {
      fetchStageService.fetchArtifact.mockResolvedValue({
        ticketKey: 'WBP-1',
        content: '# WBP-1: Title',
        path: '/tmp/.wf/jira/WBP-1.md',
        fromCache: true,
      });

      await agent.execute('WBP-1', { trackerName: 'jira', baseDir: '/tmp' });

      const output = mockConsoleLog.mock.calls.map(c => c.join(' ')).join('\n');
      expect(output).toContain('Using existing FETCH artifact');
      expect(output).not.toContain('Ticket fetched');
      expect(output).not.toContain('Ticket refetched');
    });

    it('logs force-refetch messages when skipExisting is false', async () => {
      fetchStageService.fetchArtifact.mockResolvedValue({
        ticketKey: 'WBP-2',
        content: '# WBP-2: Title',
        path: '/tmp/.wf/jira/WBP-2.md',
        fromCache: false,
      });

      await agent.execute('WBP-2', {
        trackerName: 'jira',
        baseDir: '/tmp',
        skipExisting: false,
      });

      const output = mockConsoleLog.mock.calls.map(c => c.join(' ')).join('\n');
      expect(output).toContain('--force enabled');
      expect(output).toContain('Ticket refetched');
      expect(output).not.toContain('Using existing FETCH artifact');
    });

    it('logs default fetch message for a fresh fetch', async () => {
      fetchStageService.fetchArtifact.mockResolvedValue({
        ticketKey: 'WBP-3',
        content: '# WBP-3: Title',
        path: '/tmp/.wf/jira/WBP-3.md',
        fromCache: false,
      });

      await agent.execute('WBP-3', { trackerName: 'jira', baseDir: '/tmp' });

      const output = mockConsoleLog.mock.calls.map(c => c.join(' ')).join('\n');
      expect(output).toContain('Ticket fetched');
      expect(output).not.toContain('--force enabled');
      expect(output).not.toContain('Using existing FETCH artifact');
    });

    it('suppresses all output when silent is true', async () => {
      fetchStageService.fetchArtifact.mockResolvedValue({
        ticketKey: 'WBP-4',
        content: '# WBP-4: Title',
        path: '/tmp/.wf/jira/WBP-4.md',
      });

      await agent.execute('WBP-4', {
        trackerName: 'jira',
        baseDir: '/tmp',
        silent: true,
      });

      expect(mockConsoleLog).not.toHaveBeenCalled();
    });
  });
});
