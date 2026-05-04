import { Test } from '@nestjs/testing';
import { ReviewerAgent } from './reviewer.agent';
import { GitService } from '../integrations/git/git.service';
import { ReviewStageService } from '../workflows/stages/review-stage.service';
import * as fs from 'fs';

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

  it('skips review when artifact exists and skipExisting is true', async () => {
    jest.spyOn(require('fs'), 'existsSync').mockReturnValue(true);
    jest
      .spyOn(require('fs'), 'readFileSync')
      .mockReturnValue('## Approval Status\n✓ Approved');

    const module = await Test.createTestingModule({
      providers: [
        ReviewerAgent,
        {
          provide: GitService,
          useValue: {
            getStatus: jest.fn(),
            stageAll: jest.fn(),
            getDiff: jest.fn(),
          },
        },
        {
          provide: ReviewStageService,
          useValue: {
            reviewDiff: jest.fn(),
            createReviewArtifact: jest.fn(),
          },
        },
      ],
    }).compile();

    const agent = module.get(ReviewerAgent);
    const artifact = await agent.execute(
      {
        ticketKey: 'WBP-123',
        content: '# WBP-123: Fix auth callback',
        path: '/tmp/.wf/repo/jira/WBP-123.md',
      },
      { skipExisting: true, repoDir: '/tmp/repo' },
    );

    expect(artifact?.approved).toBe(true);
  });

  it('returns null when --force is used but there are no changes to review', async () => {
    const module = await Test.createTestingModule({
      providers: [
        ReviewerAgent,
        {
          provide: GitService,
          useValue: {
            getStatus: jest.fn().mockResolvedValue({ files: [] }),
            stageAll: jest.fn().mockResolvedValue(undefined),
            getDiff: jest.fn().mockResolvedValue(''),
          },
        },
        {
          provide: ReviewStageService,
          useValue: {
            reviewDiff: jest.fn(),
            createReviewArtifact: jest.fn(),
          },
        },
      ],
    }).compile();

    const agent = module.get(ReviewerAgent);
    const artifact = await agent.execute(
      {
        ticketKey: 'WBP-123',
        content: '# WBP-123: Fix auth callback',
        path: '/tmp/.wf/repo/jira/WBP-123.md',
      },
      { skipExisting: false, repoDir: '/tmp/repo' },
    );

    expect(artifact).toBeNull();
  });
});
