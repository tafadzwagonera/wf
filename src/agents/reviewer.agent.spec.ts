import { Test } from '@nestjs/testing';
import { ReviewerAgent } from './reviewer.agent';
import { CliPresenter } from '../shared/presentation/cli-presenter.service';
import { GitService } from '../integrations/git/git.service';
import { ReviewStageService } from '../workflows/stages/review-stage.service';
import { SonarStageService } from '../review/sonar-stage.service';
import { FigmaStageService } from '../review/figma-stage.service';
import { UiDesignScreenshotsStageService } from '../review/ui-design-screenshots-stage.service';
import { CommentPolicyStageService } from '../review/comment-policy-stage.service';
import { CommitDescriptionStageService } from '../workflows/stages/commit-description-stage.service';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ConfigurationError, ExecutionError } from '../shared/utils/errors';
import { runPostPullDependencyInstall } from '../shared/utils/post-pull-install';
import { resolveVerificationSummary } from '../shared/utils/implement-verification';
import { detectRepoConventions, formatRepoConventionsPromptSection } from '../shared/utils/detect-repo-conventions';
import { appendToLogFile } from '../shared/logger/log-file-writer';

jest.mock('../shared/utils/post-pull-install');
jest.mock('../shared/utils/implement-verification');
jest.mock('../shared/utils/detect-repo-conventions');
jest.mock('../shared/logger/log-file-writer');

const mockRunPostPullDependencyInstall = jest.mocked(runPostPullDependencyInstall);
const mockResolveVerificationSummary = jest.mocked(resolveVerificationSummary);
const mockDetectRepoConventions = jest.mocked(detectRepoConventions);
const mockFormatRepoConventionsPromptSection = jest.mocked(formatRepoConventionsPromptSection);
const mockAppendToLogFile = jest.mocked(appendToLogFile);

const createMockSonarStageService = () => ({
  scanIfEnabled: jest.fn().mockResolvedValue(undefined),
});

const createMockFigmaStageService = () => ({
  resolveIfEnabled: jest.fn().mockResolvedValue(undefined),
});

const createMockCommentPolicyStageService = () => ({
  scanIfEnabled: jest.fn().mockResolvedValue(undefined),
});

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
    mockRunPostPullDependencyInstall.mockReset();
    mockResolveVerificationSummary.mockReset();
    mockDetectRepoConventions.mockReset();
    mockFormatRepoConventionsPromptSection.mockReset();
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
            getStatus: jest.fn().mockResolvedValue({ files: ['src/auth.ts'], staged: ['src/auth.ts'] }),
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
          provide: SonarStageService,
          useValue: createMockSonarStageService(),
        },
        {
          provide: FigmaStageService,
          useValue: createMockFigmaStageService(),
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
          provide: SonarStageService,
          useValue: createMockSonarStageService(),
        },
        {
          provide: FigmaStageService,
          useValue: createMockFigmaStageService(),
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
          provide: SonarStageService,
          useValue: createMockSonarStageService(),
        },
        {
          provide: FigmaStageService,
          useValue: createMockFigmaStageService(),
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
            getStatus: jest.fn().mockResolvedValue({ files: ['src/auth.ts'], staged: ['src/auth.ts'] }),
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
          provide: SonarStageService,
          useValue: createMockSonarStageService(),
        },
        {
          provide: FigmaStageService,
          useValue: createMockFigmaStageService(),
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
            getStatus: jest.fn().mockResolvedValue({ files: ['src/auth.ts'], staged: ['src/auth.ts'] }),
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
          provide: SonarStageService,
          useValue: createMockSonarStageService(),
        },
        {
          provide: FigmaStageService,
          useValue: createMockFigmaStageService(),
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

  it('delegates sonar scan to SonarStageService before reviewDiff', async () => {
    const callOrder: string[] = [];
    const mockReviewDiff = jest.fn().mockImplementation(async () => {
      callOrder.push('review');
      return { review: { summary: 'ok', issues: [], suggestions: [], approved: true } };
    });

    const module = await Test.createTestingModule({
      providers: [
        ReviewerAgent,
        { provide: CliPresenter, useValue: createMockPresenter() },
        {
          provide: GitService,
          useValue: {
            getStatus: jest.fn().mockResolvedValue({ files: ['src/auth.ts'], staged: ['src/auth.ts'] }),
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
        { provide: SonarStageService, useValue: createMockSonarStageService() },
        { provide: FigmaStageService, useValue: createMockFigmaStageService() },
      ],
    }).compile();

    const sonarStageService = module.get(SonarStageService);
    (sonarStageService.scanIfEnabled as jest.Mock).mockImplementation(async () => {
      callOrder.push('sonar');
      return { status: 'clean', steps: [] };
    });

    const agent = module.get(ReviewerAgent);
    await agent.execute(
      { ticketKey: 'WBP-123', content: '# WBP-123', path: '/tmp/.wf/repo/jira/WBP-123.md' },
      { repoDir: '/tmp/repo' }
    );

    expect(sonarStageService.scanIfEnabled).toHaveBeenCalledWith(
      expect.objectContaining({ repoDir: '/tmp/repo', ticketKey: 'WBP-123', allowPrompt: false })
    );
    expect(callOrder).toEqual(['sonar', 'review']);
  });

  it('passes ticketKey and allowPrompt:false to SonarStageService', async () => {
    const module = await Test.createTestingModule({
      providers: [
        ReviewerAgent,
        { provide: CliPresenter, useValue: createMockPresenter() },
        {
          provide: GitService,
          useValue: {
            getStatus: jest.fn().mockResolvedValue({ files: ['src/auth.ts'], staged: ['src/auth.ts'] }),
            stageAll: jest.fn().mockResolvedValue(undefined),
            getDiff: jest.fn().mockResolvedValue('diff --git a/file b/file'),
          },
        },
        {
          provide: ReviewStageService,
          useValue: {
            reviewDiff: jest.fn().mockResolvedValue({
              review: { summary: 'ok', issues: [], suggestions: [], approved: true },
            }),
            buildReviewArtifact: jest.fn().mockReturnValue({
              review: { summary: 'ok', issues: [], suggestions: [], approved: true },
              path: '/tmp/.wf/repo/jira/WBP-123-review.md',
              approved: true,
            }),
          },
        },
        { provide: SonarStageService, useValue: createMockSonarStageService() },
        { provide: FigmaStageService, useValue: createMockFigmaStageService() },
      ],
    }).compile();

    const sonarStageService = module.get(SonarStageService);
    (sonarStageService.scanIfEnabled as jest.Mock).mockResolvedValue({ status: 'clean', steps: [] });

    const agent = module.get(ReviewerAgent);
    await agent.execute(
      { ticketKey: 'WBP-123', content: '# WBP-123', path: '/tmp/.wf/repo/jira/WBP-123.md' },
      {
        repoDir: '/tmp/repo',
        forkSession: true,
        estimatedComplexity: 'high',
        passCount: 6,
        resumeProviderSessionId: 'session-1',
      }
    );

    expect(sonarStageService.scanIfEnabled).toHaveBeenCalledWith(
      expect.objectContaining({ repoDir: '/tmp/repo', ticketKey: 'WBP-123', allowPrompt: false })
    );
  });

  it('falls back to the current working directory when review repoDir is undefined', async () => {
    const cwd = process.cwd();

    const module = await Test.createTestingModule({
      providers: [
        ReviewerAgent,
        { provide: CliPresenter, useValue: createMockPresenter() },
        {
          provide: GitService,
          useValue: {
            getStatus: jest.fn().mockResolvedValue({ files: ['src/auth.ts'], staged: ['src/auth.ts'] }),
            stageAll: jest.fn().mockResolvedValue(undefined),
            getDiff: jest.fn().mockResolvedValue('diff --git a/file b/file'),
          },
        },
        {
          provide: ReviewStageService,
          useValue: {
            reviewDiff: jest.fn().mockResolvedValue({
              review: { summary: 'ok', issues: [], suggestions: [], approved: true },
            }),
            buildReviewArtifact: jest.fn().mockReturnValue({
              review: { summary: 'ok', issues: [], suggestions: [], approved: true },
              path: '/tmp/.wf/repo/jira/WBP-123-review.md',
              approved: true,
            }),
          },
        },
        { provide: SonarStageService, useValue: createMockSonarStageService() },
        { provide: FigmaStageService, useValue: createMockFigmaStageService() },
      ],
    }).compile();

    const sonarStageService = module.get(SonarStageService);
    (sonarStageService.scanIfEnabled as jest.Mock).mockResolvedValue({ status: 'clean', steps: [] });

    const agent = module.get(ReviewerAgent);
    await agent.execute(
      { ticketKey: 'WBP-123', content: '# WBP-123', path: '/tmp/.wf/repo/jira/WBP-123.md' },
      {}
    );

    expect(sonarStageService.scanIfEnabled).toHaveBeenCalledWith(
      expect.objectContaining({ repoDir: cwd })
    );
  });

  it.each([
    ['ConfigurationError', new ConfigurationError('SonarQube CLI not found.')],
    ['ExecutionError', new ExecutionError('SonarQube analyze exited with code 2.')],
  ])('continues the review when SonarStageService raises a %s', async (_name, sonarError) => {
    const mockReviewDiff = jest.fn().mockResolvedValue({
      review: { summary: 'ok', issues: [], suggestions: [], approved: true },
    });
    const presenter = createMockPresenter();

    const module = await Test.createTestingModule({
      providers: [
        ReviewerAgent,
        { provide: CliPresenter, useValue: presenter },
        {
          provide: GitService,
          useValue: {
            getStatus: jest.fn().mockResolvedValue({ files: ['src/auth.ts'], staged: ['src/auth.ts'] }),
            stageAll: jest.fn().mockResolvedValue(undefined),
            getDiff: jest.fn().mockResolvedValue('diff --git a/file b/file'),
          },
        },
        {
          provide: ReviewStageService,
          useValue: { reviewDiff: mockReviewDiff, buildReviewArtifact: jest.fn() },
        },
        { provide: SonarStageService, useValue: createMockSonarStageService() },
        { provide: FigmaStageService, useValue: createMockFigmaStageService() },
      ],
    }).compile();

    const sonarStageService = module.get(SonarStageService);
    (sonarStageService.scanIfEnabled as jest.Mock).mockRejectedValue(sonarError);

    const agent = module.get(ReviewerAgent);
    const result = await agent.execute(
      { ticketKey: 'WBP-123', content: '# WBP-123', path: '/tmp/.wf/repo/jira/WBP-123.md' },
      { repoDir: '/tmp/repo' }
    );

    expect(result).not.toBeNull();
    expect(mockReviewDiff).toHaveBeenCalled();
    expect(presenter.outcome).toHaveBeenCalledWith('warning', expect.stringContaining('continuing review'));
  });

  it('threads Sonar findings text into reviewDiff context when findings are returned', async () => {
    const mockReviewDiff = jest.fn().mockResolvedValue({
      review: { summary: 'ok', issues: [], suggestions: [], approved: true },
    });

    const module = await Test.createTestingModule({
      providers: [
        ReviewerAgent,
        { provide: CliPresenter, useValue: createMockPresenter() },
        {
          provide: GitService,
          useValue: {
            getStatus: jest.fn().mockResolvedValue({ files: ['src/auth.ts'], staged: ['src/auth.ts'] }),
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
        { provide: SonarStageService, useValue: createMockSonarStageService() },
        { provide: FigmaStageService, useValue: createMockFigmaStageService() },
      ],
    }).compile();

    const sonarStageService = module.get(SonarStageService);
    (sonarStageService.scanIfEnabled as jest.Mock).mockResolvedValue({
      status: 'findings',
      findingsText: 'SonarQube analyze findings:\nRule hit',
      steps: [{ step: 'analyze', status: 'findings', exitCode: 51, output: 'Rule hit' }],
    });

    const agent = module.get(ReviewerAgent);
    await agent.execute(
      { ticketKey: 'WBP-123', content: '# WBP-123', path: '/tmp/.wf/repo/jira/WBP-123.md' },
      { repoDir: '/tmp/repo' }
    );

    expect(mockReviewDiff).toHaveBeenCalledWith(
      'diff --git a/file b/file',
      expect.objectContaining({
        additionalContextSections: ['SonarQube analyze findings:\nRule hit'],
      })
    );
  });

  it('does not contain non-sonar errors raised while running the SonarQube CLI scan', async () => {
    const unrelatedError = new Error('unexpected failure');

    const module = await Test.createTestingModule({
      providers: [
        ReviewerAgent,
        { provide: CliPresenter, useValue: createMockPresenter() },
        {
          provide: GitService,
          useValue: {
            getStatus: jest.fn().mockResolvedValue({ files: ['src/auth.ts'], staged: ['src/auth.ts'] }),
            stageAll: jest.fn().mockResolvedValue(undefined),
            getDiff: jest.fn().mockResolvedValue('diff --git a/file b/file'),
          },
        },
        {
          provide: ReviewStageService,
          useValue: { reviewDiff: jest.fn(), buildReviewArtifact: jest.fn() },
        },
        { provide: SonarStageService, useValue: createMockSonarStageService() },
        { provide: FigmaStageService, useValue: createMockFigmaStageService() },
      ],
    }).compile();

    const sonarStageService = module.get(SonarStageService);
    (sonarStageService.scanIfEnabled as jest.Mock).mockRejectedValue(unrelatedError);

    const agent = module.get(ReviewerAgent);
    await expect(agent.execute(
      { ticketKey: 'WBP-123', content: '# WBP-123', path: '/tmp/.wf/repo/jira/WBP-123.md' },
      { repoDir: '/tmp/repo' }
    )).rejects.toThrow(unrelatedError);
  });

  it('always delegates to SonarStageService and forwards options.sonar as force', async () => {
    const module = await Test.createTestingModule({
      providers: [
        ReviewerAgent,
        { provide: CliPresenter, useValue: createMockPresenter() },
        {
          provide: GitService,
          useValue: {
            getStatus: jest.fn().mockResolvedValue({ files: ['src/auth.ts'], staged: ['src/auth.ts'] }),
            stageAll: jest.fn().mockResolvedValue(undefined),
            getDiff: jest.fn().mockResolvedValue('diff --git a/file b/file'),
          },
        },
        {
          provide: ReviewStageService,
          useValue: {
            reviewDiff: jest.fn().mockResolvedValue({
              review: { summary: 'ok', issues: [], suggestions: [], approved: true },
            }),
            buildReviewArtifact: jest.fn().mockReturnValue({
              review: { summary: 'ok', issues: [], suggestions: [], approved: true },
              path: '/tmp/.wf/repo/jira/WBP-123-review.md',
              approved: true,
            }),
          },
        },
        { provide: SonarStageService, useValue: createMockSonarStageService() },
        { provide: FigmaStageService, useValue: createMockFigmaStageService() },
      ],
    }).compile();

    const sonarStageService = module.get(SonarStageService);
    const agent = module.get(ReviewerAgent);

    await agent.execute(
      { ticketKey: 'WBP-123', content: '# WBP-123', path: '/tmp/.wf/repo/jira/WBP-123.md' },
      { repoDir: '/tmp/repo', sonar: true }
    );
    expect(sonarStageService.scanIfEnabled).toHaveBeenCalledWith(
      expect.objectContaining({ force: true })
    );

    (sonarStageService.scanIfEnabled as jest.Mock).mockClear();
    await agent.execute(
      { ticketKey: 'WBP-123', content: '# WBP-123', path: '/tmp/.wf/repo/jira/WBP-123.md' },
      { repoDir: '/tmp/repo' }
    );
    expect(sonarStageService.scanIfEnabled).toHaveBeenCalledWith(
      expect.objectContaining({ force: undefined })
    );
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
            getStatus: jest.fn().mockResolvedValue({ files: ['src/auth.ts'], staged: ['src/auth.ts'] }),
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
          provide: SonarStageService,
          useValue: createMockSonarStageService(),
        },
        {
          provide: FigmaStageService,
          useValue: createMockFigmaStageService(),
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

  describe('pre-flight and context enrichment', () => {
    const ticket = {
      ticketKey: 'WBP-123',
      content: '# WBP-123: Fix auth callback',
      path: '/tmp/.wf/repo/jira/WBP-123.md',
    };

    const buildModule = async (reviewDiffImpl?: jest.Mock) => {
      const reviewDiff = reviewDiffImpl ?? jest.fn().mockResolvedValue({
        review: { summary: 'ok', issues: [], suggestions: [], approved: true },
      });

      const module = await Test.createTestingModule({
        providers: [
          ReviewerAgent,
          { provide: CliPresenter, useValue: createMockPresenter() },
          {
            provide: GitService,
            useValue: {
              getStatus: jest.fn().mockResolvedValue({ files: ['src/auth.ts'], staged: ['src/auth.ts'] }),
              stageAll: jest.fn().mockResolvedValue(undefined),
              getDiff: jest.fn().mockResolvedValue('diff --git a/file b/file'),
            },
          },
          {
            provide: ReviewStageService,
            useValue: {
              reviewDiff,
              buildReviewArtifact: jest.fn().mockReturnValue({
                review: { summary: 'ok', issues: [], suggestions: [], approved: true },
                path: '/tmp/.wf/repo/jira/WBP-123-review.md',
                approved: true,
              }),
            },
          },
          { provide: SonarStageService, useValue: createMockSonarStageService() },
          { provide: FigmaStageService, useValue: createMockFigmaStageService() },
        ],
      }).compile();

      return {
        agent: module.get(ReviewerAgent),
        reviewStageService: module.get(ReviewStageService),
        presenter: module.get(CliPresenter),
        sonarStageService: module.get(SonarStageService),
      };
    };

    beforeEach(() => {
      mockAppendToLogFile.mockReset();
      mockRunPostPullDependencyInstall.mockReset().mockResolvedValue(undefined);
      mockResolveVerificationSummary.mockReset().mockReturnValue('');
      mockDetectRepoConventions.mockReset().mockReturnValue({} as ReturnType<typeof detectRepoConventions>);
      mockFormatRepoConventionsPromptSection.mockReset().mockReturnValue('');
    });

    it.each([
      ['silent', true],
      ['non-silent', false],
    ])('warns on screen and in the log file when the Sonar scan fails (%s run)', async (_label, silent) => {
      const { agent, presenter, sonarStageService, reviewStageService } = await buildModule();
      (sonarStageService.scanIfEnabled as jest.Mock).mockRejectedValue(new ExecutionError('sonar timed out'));

      await agent.execute(ticket, { repoDir: '/tmp/sonar-repo', silent });

      const expectedMessage = 'SonarQube CLI error — continuing review for sonar-repo without Sonar findings: '
        + 'sonar timed out';
      expect(presenter.outcome).toHaveBeenCalledWith('warning', expectedMessage);
      expect(mockAppendToLogFile).toHaveBeenCalledWith('WARN', expectedMessage, 'sonar-stage');
      expect(reviewStageService.reviewDiff).toHaveBeenCalledTimes(1);
    });

    it('runs post-pull dependency install with the resolved repoDir before reviewDiff', async () => {
      const callOrder: string[] = [];
      mockRunPostPullDependencyInstall.mockImplementation(async () => {
        callOrder.push('post-pull');
      });
      const reviewDiff = jest.fn().mockImplementation(async () => {
        callOrder.push('review');
        return { review: { summary: 'ok', issues: [], suggestions: [], approved: true } };
      });
      const { agent } = await buildModule(reviewDiff);

      await agent.execute(ticket, { repoDir: '/repo' });

      expect(mockRunPostPullDependencyInstall).toHaveBeenCalledWith('/repo');
      expect(callOrder).toEqual(['post-pull', 'review']);
    });

    it('presents the review header before running post-pull dependency install', async () => {
      const callOrder: string[] = [];
      const { agent, presenter } = await buildModule();
      (presenter.stageHeader as jest.Mock).mockImplementation(() => {
        callOrder.push('header');
      });
      mockRunPostPullDependencyInstall.mockImplementation(async () => {
        callOrder.push('post-pull');
      });

      await agent.execute(ticket, { repoDir: '/repo' });

      expect(callOrder).toEqual(['header', 'post-pull']);
    });

    it('includes a non-empty verification summary in the reviewDiff context', async () => {
      mockResolveVerificationSummary.mockReturnValue('Prior implement run (ticket WBP-123): 1 attempt(s).');
      const { agent, reviewStageService } = await buildModule();

      await agent.execute(ticket, { repoDir: '/repo' });

      expect(reviewStageService.reviewDiff).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ context: expect.stringContaining('Prior implement run (ticket WBP-123)') })
      );
    });

    it('includes the implementer plan-problem lines from the newest run artifact in the reviewDiff context', async () => {
      const wfHome = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-reviewer-plan-problem-'));
      const previousWfHome = process.env.WF_HOME;
      process.env.WF_HOME = wfHome;
      try {
        const runDir = path.join(wfHome, 'state', 'implement-verification', 'repo');
        fs.mkdirSync(runDir, { recursive: true });
        fs.writeFileSync(path.join(runDir, 'WBP-123-2026-01-01T00-00-00-000Z.json'), JSON.stringify({
          run: {
            ticketKey: 'WBP-123', repoDir: '/repo', backendConfigured: 'claude-cli', backendSelected: 'claude-cli',
            provider: 'anthropic', verificationScripts: [], startedAt: '2026-01-01T00:00:00.000Z',
            planProblems: [{ step: 1, reason: 'resolver differs from plan text', instead: 'matched the runtime resolver' }],
          },
          attempts: [],
        }));
        mockResolveVerificationSummary.mockImplementation(
          jest.requireActual<typeof import('../shared/utils/implement-verification')>(
            '../shared/utils/implement-verification',
          ).resolveVerificationSummary,
        );
        const { agent, reviewStageService } = await buildModule();

        await agent.execute(ticket, { repoDir: '/repo' });

        expect(reviewStageService.reviewDiff).toHaveBeenCalledWith(
          expect.any(String),
          expect.objectContaining({
            context: expect.stringContaining(
              '- step 1: resolver differs from plan text | instead: matched the runtime resolver',
            ),
          }),
        );
      } finally {
        if (previousWfHome === undefined) delete process.env.WF_HOME;
        else process.env.WF_HOME = previousWfHome;
        fs.rmSync(wfHome, { recursive: true, force: true });
      }
    });

    it('includes a non-empty repo conventions section in the reviewDiff context', async () => {
      mockFormatRepoConventionsPromptSection.mockReturnValue('Repository conventions (repo):\n- Language: typescript');
      const { agent, reviewStageService } = await buildModule();

      await agent.execute(ticket, { repoDir: '/repo' });

      expect(reviewStageService.reviewDiff).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ context: expect.stringContaining('Repository conventions (repo)') })
      );
    });

    it('passes the bare ticket context when verification and conventions are both empty', async () => {
      const { agent, reviewStageService } = await buildModule();

      await agent.execute(ticket, { repoDir: '/repo' });

      expect(reviewStageService.reviewDiff).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ context: 'ticket WBP-123' })
      );
    });

    it('does not run post-pull dependency install when the review is served from cache', async () => {
      jest.spyOn(require('fs'), 'existsSync').mockReturnValue(true);
      jest.spyOn(require('fs'), 'readFileSync').mockReturnValue('## Approval Status\n✔ Approved');
      const { agent } = await buildModule();

      await agent.execute(ticket, { skipExisting: true, repoDir: '/repo' });

      expect(mockRunPostPullDependencyInstall).not.toHaveBeenCalled();
    });
  });

  describe('Figma context injection', () => {
    it('passes figmaContextSection (not figmaSkillHint) containing frame name to reviewDiff', async () => {
      const mockFrames = [{ url: 'https://figma.com/design/A/F?node-id=1-1', name: 'Hero', width: 1440, height: 900, screenshotUrl: 'https://s3/img.png', layout: { name: 'Hero', width: 1440, height: 900 } }];
      const mockReviewDiff = jest.fn().mockResolvedValue({
        review: { summary: 'ok', issues: [], suggestions: [], approved: true },
      });

      const module = await Test.createTestingModule({
        providers: [
          ReviewerAgent,
          { provide: CliPresenter, useValue: createMockPresenter() },
          {
            provide: GitService,
            useValue: {
              getStatus: jest.fn().mockResolvedValue({ files: ['src/auth.ts'], staged: ['src/auth.ts'] }),
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
          { provide: SonarStageService, useValue: createMockSonarStageService() },
          {
            provide: FigmaStageService,
            useValue: { resolveIfEnabled: jest.fn().mockResolvedValue({ figmaLinks: [], frames: mockFrames }) },
          },
        ],
      }).compile();

      const agent = module.get(ReviewerAgent);
      await agent.execute(
        { ticketKey: 'WBP-123', content: '# WBP-123', path: '/tmp/.wf/repo/jira/WBP-123.md' },
        { repoDir: '/tmp/repo', figma: true }
      );

      const callArg = mockReviewDiff.mock.calls[0][1];
      expect(callArg).toHaveProperty('figmaContextSection');
      expect(callArg.figmaContextSection).toContain('Hero');
    });
  });

  describe('multi-repo repoScope threading', () => {
    afterEach(() => jest.restoreAllMocks());

    it('passes the repo basename as repoScope to buildReviewArtifact in a multi-repo session', async () => {
      jest.spyOn(require('fs'), 'existsSync').mockReturnValue(false);

      const mockTicket = { ticketKey: 'WBP-200', content: '# WBP-200', path: '/tmp/.wf/WBP-200.md' };

      const buildModuleWithArtifactMock = (repoDir: string) => {
        const buildArtifactMock = jest.fn().mockReturnValue({ review: {}, path: '/tmp/irrelevant.md', approved: true });
        const modulePromise = Test.createTestingModule({
          providers: [
            ReviewerAgent,
            { provide: CliPresenter, useValue: createMockPresenter() },
            {
              provide: GitService,
              useValue: {
                getStatus: jest.fn().mockResolvedValue({ files: ['src/some.ts'] }),
                stageAll: jest.fn(),
                getDiff: jest.fn().mockResolvedValue('diff --git a/src/some.ts b/src/some.ts'),
              },
            },
            {
              provide: ReviewStageService,
              useValue: {
                reviewDiff: jest.fn().mockResolvedValue({ review: { summary: 'ok', issues: [], suggestions: [], approved: true }, sessionId: undefined }),
                buildReviewArtifact: buildArtifactMock,
              },
            },
            { provide: SonarStageService, useValue: createMockSonarStageService() },
            { provide: FigmaStageService, useValue: createMockFigmaStageService() },
          ],
        }).compile();
        return { modulePromise, buildArtifactMock };
      };

      const { modulePromise: promiseA, buildArtifactMock: mockA } = buildModuleWithArtifactMock('/tmp/repo-shop');
      const moduleA = await promiseA;
      await moduleA.get(ReviewerAgent).execute(mockTicket, { repoDir: '/tmp/repo-shop', skipExisting: true });

      const { modulePromise: promiseB, buildArtifactMock: mockB } = buildModuleWithArtifactMock('/tmp/repo-api');
      const moduleB = await promiseB;
      await moduleB.get(ReviewerAgent).execute(mockTicket, { repoDir: '/tmp/repo-api', skipExisting: true });

      expect(mockA.mock.calls[0][3]).toBe('repo-shop');
      expect(mockB.mock.calls[0][3]).toBe('repo-api');
    });
  });

  describe('UI design screenshots integration', () => {
    afterEach(() => {
      jest.restoreAllMocks();
    });

    it('calls resolveIfEnabled and passes screenshots to reviewDiff', async () => {
      const mockScreenshot = { path: '/p/a.png', mediaType: 'image/png' as const, base64: 'x' };
      const mockReviewDiff = jest.fn().mockResolvedValue({
        review: { summary: 'ok', issues: [], suggestions: [], approved: true },
      });
      const mockResolveIfEnabled = jest.fn().mockResolvedValue({
        screenshots: [mockScreenshot], paths: ['/p/a.png'],
      });

      const module = await Test.createTestingModule({
        providers: [
          ReviewerAgent,
          { provide: CliPresenter, useValue: createMockPresenter() },
          {
            provide: GitService,
            useValue: {
              getStatus: jest.fn().mockResolvedValue({ files: ['src/auth.ts'], staged: ['src/auth.ts'] }),
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
          { provide: SonarStageService, useValue: createMockSonarStageService() },
          { provide: FigmaStageService, useValue: createMockFigmaStageService() },
          {
            provide: UiDesignScreenshotsStageService,
            useValue: { resolveIfEnabled: mockResolveIfEnabled },
          },
        ],
      }).compile();

      const agent = module.get(ReviewerAgent);

      await agent.execute(
        { ticketKey: 'WBP-123', content: '# WBP-123: Fix auth', path: '/tmp/.wf/repo/jira/WBP-123.md' },
        { repoDir: '/tmp/repo', planArtifactPath: '/tmp/.wf/repo/jira/WBP-123-plan.json' }
      );

      expect(mockResolveIfEnabled).toHaveBeenCalledWith(
        expect.objectContaining({ artifactPath: '/tmp/.wf/repo/jira/WBP-123-plan.json' })
      );
      expect(mockReviewDiff).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ screenshots: [mockScreenshot] })
      );
    });

    it('omits screenshots from reviewDiff when service is not provided', async () => {
      const mockReviewDiff = jest.fn().mockResolvedValue({
        review: { summary: 'ok', issues: [], suggestions: [], approved: true },
      });

      const module = await Test.createTestingModule({
        providers: [
          ReviewerAgent,
          { provide: CliPresenter, useValue: createMockPresenter() },
          {
            provide: GitService,
            useValue: {
              getStatus: jest.fn().mockResolvedValue({ files: ['src/auth.ts'], staged: ['src/auth.ts'] }),
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
          { provide: SonarStageService, useValue: createMockSonarStageService() },
          { provide: FigmaStageService, useValue: createMockFigmaStageService() },
        ],
      }).compile();

      const agent = module.get(ReviewerAgent);
      await agent.execute(
        { ticketKey: 'WBP-123', content: '# WBP-123: Fix auth', path: '/tmp/.wf/repo/jira/WBP-123.md' },
        { repoDir: '/tmp/repo' }
      );

      expect(mockReviewDiff).toHaveBeenCalledWith(
        expect.any(String),
        expect.not.objectContaining({ screenshots: expect.anything() })
      );
    });
  });

  describe('comment policy wiring', () => {
    const buildModule = async (commentPolicyService: ReturnType<typeof createMockCommentPolicyStageService>) => {
      const module = await Test.createTestingModule({
        providers: [
          ReviewerAgent,
          {
            provide: CliPresenter,
            useValue: {
              stageHeader: jest.fn(),
              separator: jest.fn(),
              progress: jest.fn(),
              outcome: jest.fn(),
              detail: jest.fn(),
              summaryBlock: jest.fn(),
            },
          },
          {
            provide: GitService,
            useValue: {
              getStatus: jest.fn().mockResolvedValue({ files: ['src/auth.ts'], staged: ['src/auth.ts'] }),
              stageAll: jest.fn().mockResolvedValue(undefined),
              getDiff: jest.fn().mockResolvedValue('diff --git a/file b/file'),
            },
          },
          {
            provide: ReviewStageService,
            useValue: {
              reviewDiff: jest.fn().mockResolvedValue({
                review: { summary: 'ok', issues: [], suggestions: [], approved: true },
              }),
              buildReviewArtifact: jest.fn().mockImplementation((_ticket: unknown, review: unknown) => ({
                review,
                path: '/tmp/.wf/repo/jira/WBP-123-review.md',
                approved: true,
              })),
            },
          },
          { provide: SonarStageService, useValue: createMockSonarStageService() },
          { provide: FigmaStageService, useValue: createMockFigmaStageService() },
          { provide: CommentPolicyStageService, useValue: commentPolicyService },
        ],
      }).compile();

      return {
        agent: module.get(ReviewerAgent),
        reviewStageService: module.get(ReviewStageService),
        commentPolicyService,
      };
    };

    it('passes commentPolicyEnabled: true to reviewDiff when scan returns a result', async () => {
      const commentPolicyService = createMockCommentPolicyStageService();
      commentPolicyService.scanIfEnabled.mockResolvedValue({ findings: [] });
      const { agent, reviewStageService } = await buildModule(commentPolicyService);

      await agent.execute(
        { ticketKey: 'WBP-123', content: '# WBP-123', path: '/tmp/.wf/repo/jira/WBP-123.md' },
        { repoDir: '/tmp/repo' }
      );

      const opts = (reviewStageService.reviewDiff as jest.Mock).mock.calls[0][1];
      expect(opts.commentPolicyEnabled).toBe(true);
    });

    it('passes commentPolicyEnabled: false to reviewDiff when scan returns undefined', async () => {
      const commentPolicyService = createMockCommentPolicyStageService();
      commentPolicyService.scanIfEnabled.mockResolvedValue(undefined);
      const { agent, reviewStageService } = await buildModule(commentPolicyService);

      await agent.execute(
        { ticketKey: 'WBP-123', content: '# WBP-123', path: '/tmp/.wf/repo/jira/WBP-123.md' },
        { repoDir: '/tmp/repo' }
      );

      const opts = (reviewStageService.reviewDiff as jest.Mock).mock.calls[0][1];
      expect(opts.commentPolicyEnabled).toBe(false);
    });

    it('merges comment-policy findings into review.issues', async () => {
      const commentPolicyService = createMockCommentPolicyStageService();
      commentPolicyService.scanIfEnabled.mockResolvedValue({ findings: [{ file: 'src/foo.ts', line: 3 }] });
      const { agent, reviewStageService } = await buildModule(commentPolicyService);
      (reviewStageService.reviewDiff as jest.Mock).mockResolvedValue({
        review: { issues: [], summary: 'ok', suggestions: [], approved: true },
      });

      const result = await agent.execute(
        { ticketKey: 'WBP-123', content: '# WBP-123', path: '/tmp/.wf/repo/jira/WBP-123.md' },
        { repoDir: '/tmp/repo' }
      );

      expect(result?.review.issues).toHaveLength(1);
      expect(result?.review.issues[0].origin).toBe('comment-policy');
    });
  });
  describe('plan risks in the review context', () => {
    const ticket = {
      ticketKey: 'WBP-123',
      content: '# WBP-123',
      path: '/tmp/.wf/repo/jira/WBP-123.md',
    };
    let tmpDir: string;

    const buildAgent = async () => {
      const reviewDiff = jest.fn().mockResolvedValue({
        review: { summary: 'ok', issues: [], suggestions: [], approved: true },
      });
      const presenter = createMockPresenter();
      const module = await Test.createTestingModule({
        providers: [
          ReviewerAgent,
          { provide: CliPresenter, useValue: presenter },
          {
            provide: GitService,
            useValue: {
              getStatus: jest.fn().mockResolvedValue({ files: ['src/auth.ts'], staged: ['src/auth.ts'] }),
              stageAll: jest.fn().mockResolvedValue(undefined),
              getDiff: jest.fn().mockResolvedValue('diff --git a/file b/file'),
            },
          },
          {
            provide: ReviewStageService,
            useValue: {
              reviewDiff,
              buildReviewArtifact: jest.fn().mockReturnValue({
                review: { summary: 'ok', issues: [], suggestions: [], approved: true },
                path: '/tmp/.wf/repo/jira/WBP-123-review.md',
                approved: true,
              }),
            },
          },
          { provide: SonarStageService, useValue: createMockSonarStageService() },
          { provide: FigmaStageService, useValue: createMockFigmaStageService() },
          { provide: CommentPolicyStageService, useValue: createMockCommentPolicyStageService() },
        ],
      }).compile();

      return { agent: module.get(ReviewerAgent), reviewDiff, presenter };
    };

    const writePlan = (risks: { description: string; severity: string }[]): string => {
      const planPath = path.join(tmpDir, 'WBP-123-plan.json');
      fs.writeFileSync(planPath, JSON.stringify({ action: 'fix', summary: 'Test fix', steps: [], risks }));
      return planPath;
    };

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reviewer-plan-risks-'));
      mockAppendToLogFile.mockReset();
      mockResolveVerificationSummary.mockReset().mockReturnValue('');
      mockDetectRepoConventions.mockReset().mockReturnValue({} as ReturnType<typeof detectRepoConventions>);
      mockFormatRepoConventionsPromptSection.mockReset().mockReturnValue('');
    });

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('adds the known plan risks to the reviewDiff context when the plan lists risks', async () => {
      const { agent, reviewDiff } = await buildAgent();
      const planArtifactPath = writePlan([
        { description: 'Database migration risk', severity: 'high' },
        { description: 'Performance impact', severity: 'medium' },
      ]);

      await agent.execute(ticket, { repoDir: '/tmp/repo', planArtifactPath });

      expect(reviewDiff).toHaveBeenCalledTimes(1);
      const { context } = reviewDiff.mock.calls[0][1];
      expect(context).toContain('Known plan risks');
      expect(context).toContain('- [high] Database migration risk');
      expect(context).toContain('- [medium] Performance impact');
    });

    it('omits the plan risks section when no plan artifact path is given', async () => {
      const { agent, reviewDiff, presenter } = await buildAgent();

      await agent.execute(ticket, { repoDir: '/tmp/repo' });

      expect(reviewDiff).toHaveBeenCalledTimes(1);
      expect(reviewDiff.mock.calls[0][1].context).toBe('ticket WBP-123');
      expect(presenter.outcome).not.toHaveBeenCalledWith('warning', expect.anything());
    });

    it('omits the section, warns on screen and logs a WARN when the plan file is unreadable', async () => {
      const { agent, reviewDiff, presenter } = await buildAgent();
      const planArtifactPath = path.join(tmpDir, 'missing-plan.json');

      await agent.execute(ticket, { repoDir: '/tmp/repo', planArtifactPath });

      expect(reviewDiff).toHaveBeenCalledTimes(1);
      expect(reviewDiff.mock.calls[0][1].context).toBe('ticket WBP-123');
      expect(presenter.outcome).toHaveBeenCalledWith(
        'warning', expect.stringContaining(`unable to load plan risks from ${planArtifactPath}`)
      );
      expect(mockAppendToLogFile).toHaveBeenCalledWith(
        'WARN', expect.stringContaining(planArtifactPath), 'plan-risks'
      );
    });
  });

  describe('commit description generation', () => {
    const stagedDiff = 'diff --git a/src/auth.ts b/src/auth.ts\n+change';
    const ticket = { ticketKey: 'WBP-123', content: '# WBP-123: Fix', path: '/tmp/.wf/repo/jira/WBP-123.md' };

    const buildAgent = async () => {
      const module = await Test.createTestingModule({
        providers: [
          ReviewerAgent,
          { provide: CliPresenter, useValue: createMockPresenter() },
          {
            provide: GitService,
            useValue: {
              getStatus: jest.fn().mockResolvedValue({ files: ['src/auth.ts'], staged: ['src/auth.ts'] }),
              stageAll: jest.fn().mockResolvedValue(undefined),
              getDiff: jest.fn().mockResolvedValue(stagedDiff),
            },
          },
          {
            provide: ReviewStageService,
            useValue: {
              reviewDiff: jest.fn().mockResolvedValue({
                review: { summary: 'ok', issues: [], suggestions: [], approved: true },
              }),
              buildReviewArtifact: jest.fn().mockReturnValue({
                review: { summary: 'ok', issues: [], suggestions: [], approved: true },
                path: '/tmp/.wf/repo/jira/WBP-123-review.md',
                approved: true,
              }),
            },
          },
          { provide: SonarStageService, useValue: createMockSonarStageService() },
          { provide: FigmaStageService, useValue: createMockFigmaStageService() },
          {
            provide: CommitDescriptionStageService,
            useValue: { generateAndPersist: jest.fn().mockResolvedValue(undefined) },
          },
        ],
      }).compile();
      return { agent: module.get(ReviewerAgent), description: module.get(CommitDescriptionStageService) };
    };

    it('persists a commit description from the reviewed staged diff', async () => {
      const { agent, description } = await buildAgent();

      await agent.execute(ticket, { repoDir: '/tmp/repo', commitDescriptionPath: '/tmp/x-review.commit-description.json' });

      expect(description.generateAndPersist).toHaveBeenCalledTimes(1);
      expect(description.generateAndPersist).toHaveBeenCalledWith(expect.objectContaining({
        diff: stagedDiff,
        stage: 'review',
        artifactPath: '/tmp/x-review.commit-description.json',
      }));
    });

    it('skips generation with a debug log when no commitDescriptionPath is given', async () => {
      const { agent, description } = await buildAgent();

      await agent.execute(ticket, { repoDir: '/tmp/repo' });

      expect(description.generateAndPersist).not.toHaveBeenCalled();
      expect(mockAppendToLogFile).toHaveBeenCalledWith('DEBUG', expect.stringContaining('commit-description'), 'reviewer');
    });

    it('skips generation when the cached review is returned', async () => {
      jest.spyOn(require('fs'), 'existsSync').mockReturnValue(true);
      jest.spyOn(require('fs'), 'readFileSync').mockReturnValue('## Approval Status\n✔ Approved');
      const { agent, description } = await buildAgent();

      await agent.execute(ticket, {
        repoDir: '/tmp/repo', skipExisting: true, commitDescriptionPath: '/tmp/x-review.commit-description.json',
      });

      expect(description.generateAndPersist).not.toHaveBeenCalled();
    });
  });
});
