import { Test } from '@nestjs/testing';
import { ReviewerAgent } from './reviewer.agent';
import { GitService } from '../integrations/git/git.service';
import { ReviewStageService } from '../workflows/stages/review-stage.service';

describe('ReviewerAgent', () => {
  it('delegates review generation to ReviewStageService', async () => {
    const module = await Test.createTestingModule({
      providers: [
        ReviewerAgent,
        {
          provide: GitService,
          useValue: {
            getStatus: jest.fn().mockResolvedValue({ files: ['src/auth.ts'] }),
            stageAll: jest.fn().mockResolvedValue(undefined),
            getDiff: jest.fn().mockResolvedValue('diff --git a/file b/file'),
          },
        },
        {
          provide: ReviewStageService,
          useValue: {
            reviewDiff: jest.fn().mockResolvedValue({
              summary: 'ok',
              issues: [],
              suggestions: [],
              approved: true,
            }),
            createReviewArtifact: jest.fn().mockReturnValue({
              review: {
                summary: 'ok',
                issues: [],
                suggestions: [],
                approved: true,
              },
              path: '/tmp/.wf/repo/jira/WBP-123-review.md',
              approved: true,
            }),
          },
        },
      ],
    }).compile();

    const agent = module.get(ReviewerAgent);
    const reviewStageService = module.get(ReviewStageService);

    await agent.execute(
      {
        ticketKey: 'WBP-123',
        content: '# WBP-123: Fix auth callback',
        path: '/tmp/.wf/repo/jira/WBP-123.md',
      },
      { repoDir: '/tmp/repo' },
    );

    expect(reviewStageService.reviewDiff).toHaveBeenCalledWith(
      'diff --git a/file b/file',
      expect.objectContaining({
        context: 'ticket WBP-123',
        repoDir: '/tmp/repo',
      }),
    );
  });
});
