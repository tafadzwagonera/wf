import { Test } from '@nestjs/testing';
import { FetcherAgent } from './fetcher.agent';
import { FetchStageService } from '../workflows/stages/fetch-stage.service';

describe('FetcherAgent', () => {
  it('delegates artifact fetching to FetchStageService', async () => {
    const module = await Test.createTestingModule({
      providers: [
        FetcherAgent,
        {
          provide: FetchStageService,
          useValue: {
            fetchArtifact: jest.fn().mockResolvedValue({
              ticketKey: 'WBP-123',
              content: '# WBP-123: Fix auth flow',
              path: '/tmp/.wf/repo/jira/WBP-123.md',
            }),
            loadArtifact: jest.fn(),
          },
        },
      ],
    }).compile();

    const agent = module.get(FetcherAgent);
    const fetchStageService = module.get(FetchStageService);

    await agent.execute('WBP-123', {
      platformName: 'jira',
      baseDir: '/tmp/repo',
    });

    expect(fetchStageService.fetchArtifact).toHaveBeenCalledWith('WBP-123', {
      platformName: 'jira',
      baseDir: '/tmp/repo',
    });
  });
});
