import { Test } from '@nestjs/testing';
import { ReviewerAgent } from './reviewer.agent';
import { CliPresenter } from '../shared/presentation/cli-presenter.service';
import { GitService } from '../integrations/git/git.service';
import { ReviewStageService } from '../workflows/stages/review-stage.service';
import { SonarStageService } from '../review/sonar-stage.service';
import { FigmaStageService } from '../review/figma-stage.service';
import * as fs from 'fs';
import { ConfigurationError, ExecutionError } from '../shared/utils/errors';
import { runPostPullDependencyInstall } from '../shared/utils/post-pull-install';
import { resolveVerificationSummary } from '../shared/utils/implement-verification';
import { detectRepoConventions, formatRepoConventionsPromptSection } from '../shared/utils/detect-repo-conventions';

jest.mock('../shared/utils/post-pull-install');
jest.mock('../shared/utils/implement-verification');
jest.mock('../shared/utils/detect-repo-conventions');

const mockRunPostPullDependencyInstall = jest.mocked(runPostPullDependencyInstall);
const mockResolveVerificationSummary = jest.mocked(resolveVerificationSummary);
const mockDetectRepoConventions = jest.mocked(detectRepoConventions);
const mockFormatRepoConventionsPromptSection = jest.mocked(formatRepoConventionsPromptSection);

const createMockSonarStageService = () => ({
  scanIfEnabled: jest.fn().mockResolvedValue(undefined),
});

const createMockFigmaStageService = () => ({
  resolveIfEnabled: jest.fn().mockResolvedValue(undefined),
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

      return { agent: module.get(ReviewerAgent), reviewStageService: module.get(ReviewStageService) };
    };

    beforeEach(() => {
      mockRunPostPullDependencyInstall.mockReset().mockResolvedValue(undefined);
      mockResolveVerificationSummary.mockReset().mockReturnValue('');
      mockDetectRepoConventions.mockReset().mockReturnValue({} as ReturnType<typeof detectRepoConventions>);
      mockFormatRepoConventionsPromptSection.mockReset().mockReturnValue('');
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

    it('includes a non-empty verification summary in the reviewDiff context', async () => {
      mockResolveVerificationSummary.mockReturnValue('Prior implement run (ticket WBP-123): 1 attempt(s).');
      const { agent, reviewStageService } = await buildModule();

      await agent.execute(ticket, { repoDir: '/repo' });

      expect(reviewStageService.reviewDiff).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ context: expect.stringContaining('Prior implement run (ticket WBP-123)') })
      );
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
      const mockFrames = [{ url: 'https://figma.com/design/A/F?node-id=1-1', name: 'Hero', width: 1440, height: 900, screenshotUrl: 'https://s3/img.png' }];
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
});
