import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { ReviewerAgent } from './reviewer.agent';
import { CliPresenter } from '../shared/presentation/cli-presenter.service';
import { GitService } from '../integrations/git/git.service';
import { ReviewStageService } from '../workflows/stages/review-stage.service';
import * as fs from 'fs';

describe('ReviewerAgent', () => {
  const createMockPresenter = () => ({
    stageHeader: jest.fn(),
    separator: jest.fn(),
    progress: jest.fn(),
    outcome: jest.fn(),
    detail: jest.fn(),
    summaryBlock: jest.fn(),
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('delegates review generation to ReviewStageService', async () => {
    const presenter = createMockPresenter();
    const module = await Test.createTestingModule({
      providers: [
        ReviewerAgent,
        {
          provide: CliPresenter,
          useValue: presenter,
        },
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
              review: {
                summary: 'ok',
                issues: [],
                suggestions: [],
                approved: true,
              },
            }),
            buildReviewArtifact: jest.fn().mockReturnValue({
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
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn().mockReturnValue(undefined),
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
      { repoDir: '/tmp/repo' }
    );

    expect(reviewStageService.reviewDiff).toHaveBeenCalledWith(
      'diff --git a/file b/file',
      expect.objectContaining({
        context: 'ticket WBP-123',
        repoDir: '/tmp/repo',
      })
    );
  });

  it('skips review when artifact exists and skipExisting is true', async () => {
    jest.spyOn(require('fs'), 'existsSync').mockReturnValue(true);
    jest.spyOn(require('fs'), 'readFileSync').mockReturnValue('## Approval Status\n✔ Approved');

    const module = await Test.createTestingModule({
      providers: [
        ReviewerAgent,
        {
          provide: CliPresenter,
          useValue: createMockPresenter(),
        },
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
            buildReviewArtifact: jest.fn(),
          },
        },
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn().mockReturnValue(undefined),
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
      { skipExisting: true, repoDir: '/tmp/repo' }
    );

    expect(artifact?.approved).toBe(true);
  });

  it('returns null when --force is used but there are no changes to review', async () => {
    const module = await Test.createTestingModule({
      providers: [
        ReviewerAgent,
        {
          provide: CliPresenter,
          useValue: createMockPresenter(),
        },
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
            buildReviewArtifact: jest.fn(),
          },
        },
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn().mockReturnValue(undefined),
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
      { skipExisting: false, repoDir: '/tmp/repo' }
    );

    expect(artifact).toBeNull();
  });

  it('streams progress via default callback when no onProgress is provided and silent is false', async () => {
    const mockReviewDiff = jest.fn().mockImplementation(
      (_diff: string, opts: { onProgress?: (line: string) => void }) => {
        opts.onProgress?.('Synthesizing review...');
        return Promise.resolve({
          review: {
            summary: 'ok',
            issues: [],
            suggestions: [],
            approved: true,
          },
        });
      }
    );

    const module = await Test.createTestingModule({
      providers: [
        ReviewerAgent,
        {
          provide: CliPresenter,
          useValue: createMockPresenter(),
        },
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
            reviewDiff: mockReviewDiff,
            buildReviewArtifact: jest.fn().mockReturnValue({
              review: { summary: 'ok', issues: [], suggestions: [], approved: true },
              path: '/tmp/.wf/repo/jira/WBP-123-review.md',
              approved: true,
            }),
          },
        },
        {
          provide: ConfigService,
          useValue: { get: jest.fn().mockReturnValue(undefined) },
        },
      ],
    }).compile();

    const agent = module.get(ReviewerAgent);
    const presenter = module.get(CliPresenter);

    await agent.execute(
      { ticketKey: 'WBP-123', content: '# WBP-123', path: '/tmp/.wf/repo/jira/WBP-123.md' },
      { repoDir: '/tmp/repo', silent: false }
    );

    expect(presenter.progress).toHaveBeenCalledWith('Synthesizing review...');
  });

  it('uses caller-provided onProgress instead of default', async () => {
    const mockOnProgress = jest.fn();
    const mockReviewDiff = jest.fn().mockImplementation(
      (_diff: string, opts: { onProgress?: (line: string) => void }) => {
        opts.onProgress?.('Synthesizing review...');
        return Promise.resolve({
          review: {
            summary: 'ok',
            issues: [],
            suggestions: [],
            approved: true,
          },
        });
      }
    );

    const module = await Test.createTestingModule({
      providers: [
        ReviewerAgent,
        {
          provide: CliPresenter,
          useValue: createMockPresenter(),
        },
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
            reviewDiff: mockReviewDiff,
            buildReviewArtifact: jest.fn().mockReturnValue({
              review: { summary: 'ok', issues: [], suggestions: [], approved: true },
              path: '/tmp/.wf/repo/jira/WBP-123-review.md',
              approved: true,
            }),
          },
        },
        {
          provide: ConfigService,
          useValue: { get: jest.fn().mockReturnValue(undefined) },
        },
      ],
    }).compile();

    const agent = module.get(ReviewerAgent);
    const presenter = module.get(CliPresenter);

    await agent.execute(
      { ticketKey: 'WBP-123', content: '# WBP-123', path: '/tmp/.wf/repo/jira/WBP-123.md' },
      { repoDir: '/tmp/repo', silent: false, onProgress: mockOnProgress }
    );

    expect(mockOnProgress).toHaveBeenCalledWith('Synthesizing review...');
    expect(presenter.progress).not.toHaveBeenCalledWith('Synthesizing review...');
  });

  it('suppresses progress when silent is true and no onProgress is provided', async () => {
    const mockReviewDiff = jest.fn().mockImplementation(
      (_diff: string, opts: { onProgress?: (line: string) => void }) => {
        opts.onProgress?.('Synthesizing review...');
        return Promise.resolve({
          review: {
            summary: 'ok',
            issues: [],
            suggestions: [],
            approved: true,
          },
        });
      }
    );

    const module = await Test.createTestingModule({
      providers: [
        ReviewerAgent,
        {
          provide: CliPresenter,
          useValue: createMockPresenter(),
        },
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
            reviewDiff: mockReviewDiff,
            buildReviewArtifact: jest.fn().mockReturnValue({
              review: { summary: 'ok', issues: [], suggestions: [], approved: true },
              path: '/tmp/.wf/repo/jira/WBP-123-review.md',
              approved: true,
            }),
          },
        },
        {
          provide: ConfigService,
          useValue: { get: jest.fn().mockReturnValue(undefined) },
        },
      ],
    }).compile();

    const agent = module.get(ReviewerAgent);
    const presenter = module.get(CliPresenter);

    await agent.execute(
      { ticketKey: 'WBP-123', content: '# WBP-123', path: '/tmp/.wf/repo/jira/WBP-123.md' },
      { repoDir: '/tmp/repo', silent: true }
    );

    expect(presenter.progress).not.toHaveBeenCalledWith('Synthesizing review...');
  });
});
