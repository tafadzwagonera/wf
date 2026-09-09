jest.mock('../shared/utils/plan-artifact', () => {
  const actual = jest.requireActual('../shared/utils/plan-artifact');
  return {
    ...actual,
    findPlanArtifactManifestByBranchName: jest.fn().mockReturnValue(undefined),
    readPlanArtifactManifest: jest.fn().mockReturnValue(null),
  };
});

import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { FigmaStageService } from './figma-stage.service';
import { FigmaRestClient } from '../integrations/figma/figma-rest.client';
import { GitService } from '../integrations/git/git.service';
import { LoggerService } from '../shared/logger/logger.service';
import { findPlanArtifactManifestByBranchName, readPlanArtifactManifest } from '../shared/utils/plan-artifact';

const mockFigmaRestClient = { fetchFrames: jest.fn() };

async function buildService() {
  const mockConfigService = { get: jest.fn().mockReturnValue(undefined) };
  const mockGitService = {
    getBranchInfo: jest.fn().mockResolvedValue({
      current: 'feat/abc', all: ['feat/abc', 'main'], isClean: true, hasUncommittedChanges: false,
    }),
  };
  const mockLoggerService = { warn: jest.fn(), error: jest.fn(), info: jest.fn() };

  const module: TestingModule = await Test.createTestingModule({
    providers: [
      FigmaStageService,
      { provide: ConfigService, useValue: mockConfigService },
      { provide: GitService, useValue: mockGitService },
      { provide: LoggerService, useValue: mockLoggerService },
      { provide: FigmaRestClient, useValue: mockFigmaRestClient },
    ],
  }).compile();

  return {
    service: module.get(FigmaStageService),
    mockConfigService,
    mockGitService,
    mockLoggerService,
  };
}

describe('FigmaStageService', () => {
  afterEach(() => {
    jest.restoreAllMocks();
    mockFigmaRestClient.fetchFrames.mockReset();
    (findPlanArtifactManifestByBranchName as jest.Mock).mockClear();
    (readPlanArtifactManifest as jest.Mock).mockClear();
    (readPlanArtifactManifest as jest.Mock).mockReturnValue(null);
  });

  describe('resolveIfEnabled', () => {
    it('returns undefined when config is false and force is false', async () => {
      const { service, mockConfigService } = await buildService();
      mockConfigService.get.mockReturnValue(false);
      const result = await service.resolveIfEnabled({ repoDir: '/repo', force: false });
      expect(result).toBeUndefined();
    });

    it('consults options.configKey instead of stages.review.figma when configKey is provided', async () => {
      const { service, mockConfigService } = await buildService();
      mockConfigService.get.mockImplementation((key: string) =>
        key === 'stages.implement.figma'
      );
      (findPlanArtifactManifestByBranchName as jest.Mock).mockReturnValue({
        sourceBranch: 'main',
        figmaLinks: ['https://figma.com/design/X/Page?node-id=1-1'],
      });
      mockFigmaRestClient.fetchFrames.mockResolvedValue([]);

      const result = await service.resolveIfEnabled({
        repoDir: '/repo', force: false, configKey: 'stages.implement.figma',
      });

      expect(result).toBeDefined();
      expect(mockConfigService.get).toHaveBeenCalledWith('stages.implement.figma');
      expect(mockConfigService.get).not.toHaveBeenCalledWith('stages.review.figma');
    });

    it('returns undefined and warns when enabled but manifest has no figmaLinks', async () => {
      const { service, mockConfigService, mockLoggerService } = await buildService();
      mockConfigService.get.mockReturnValue(true);
      (findPlanArtifactManifestByBranchName as jest.Mock).mockReturnValue({
        sourceBranch: 'main',
        figmaLinks: undefined,
      });
      const onProgress = jest.fn();
      const result = await service.resolveIfEnabled({ repoDir: '/repo', force: true, onProgress });
      expect(result).toBeUndefined();
      expect(mockLoggerService.warn).toHaveBeenCalledTimes(1);
      expect(onProgress).toHaveBeenCalledTimes(1);
    });

    it('returns figmaLinks, baseBranch, and frames when manifest has links', async () => {
      const { service, mockConfigService } = await buildService();
      mockConfigService.get.mockReturnValue(true);
      (findPlanArtifactManifestByBranchName as jest.Mock).mockReturnValue({
        sourceBranch: 'main',
        figmaLinks: ['https://figma.com/design/X/Page?node-id=1-1'],
      });
      mockFigmaRestClient.fetchFrames.mockResolvedValue([
        { url: 'https://figma.com/design/X/Page?node-id=1-1', name: 'F', width: 100, height: 100, screenshotUrl: 'https://img', layout: { name: 'F', width: 100, height: 100 } },
      ]);
      const result = await service.resolveIfEnabled({ repoDir: '/repo', force: true });
      expect(result).toEqual({
        figmaLinks: ['https://figma.com/design/X/Page?node-id=1-1'],
        baseBranch: 'main',
        frames: [{ url: 'https://figma.com/design/X/Page?node-id=1-1', name: 'F', width: 100, height: 100, screenshotUrl: 'https://img', layout: { name: 'F', width: 100, height: 100 } }],
      });
    });

    it('skips manifest lookup and uses overrideLinks when provided', async () => {
      const { service } = await buildService();
      const overrideLinks = ['https://figma.com/design/A/Page?node-id=2-3'];
      mockFigmaRestClient.fetchFrames.mockResolvedValue([
        { url: overrideLinks[0], name: 'Override', width: 200, height: 300, screenshotUrl: 'https://img2', layout: { name: 'Override', width: 200, height: 300 } },
      ]);
      const result = await service.resolveIfEnabled({ repoDir: '/repo', force: true, overrideLinks });
      expect(result?.figmaLinks).toEqual(overrideLinks);
      expect(result?.frames).toHaveLength(1);
      expect(findPlanArtifactManifestByBranchName).not.toHaveBeenCalled();
    });

    it('returns frames: [] in degraded mode when fetchFrames returns empty', async () => {
      const { service, mockConfigService } = await buildService();
      mockConfigService.get.mockReturnValue(true);
      (findPlanArtifactManifestByBranchName as jest.Mock).mockReturnValue({
        sourceBranch: 'main',
        figmaLinks: ['https://figma.com/design/X/Page?node-id=1-1'],
      });
      mockFigmaRestClient.fetchFrames.mockResolvedValue([]);
      const result = await service.resolveIfEnabled({ repoDir: '/repo', force: true });
      expect(result?.figmaLinks).toEqual(['https://figma.com/design/X/Page?node-id=1-1']);
      expect(result?.frames).toEqual([]);
    });

    it('warns with a distinct message when figmaLinks are non-empty but all frame fetches return []', async () => {
      const { service, mockConfigService, mockLoggerService } = await buildService();
      mockConfigService.get.mockReturnValue(true);
      (findPlanArtifactManifestByBranchName as jest.Mock).mockReturnValue({
        sourceBranch: 'main',
        figmaLinks: ['https://figma.com/design/X/Page?node-id=1-1'],
      });
      mockFigmaRestClient.fetchFrames.mockResolvedValue([]);
      const onProgress = jest.fn();

      const result = await service.resolveIfEnabled({ repoDir: '/repo', force: true, onProgress });

      expect(result?.frames).toEqual([]);
      expect(mockLoggerService.warn).toHaveBeenCalledTimes(1);
      expect(onProgress).toHaveBeenCalledTimes(1);
      const warnMsg: string = mockLoggerService.warn.mock.calls[0][0];
      expect(warnMsg).not.toContain('no Figma links were captured');
    });

    it('does not warn when fetchFrames returns at least one frame (partial success)', async () => {
      const { service, mockConfigService, mockLoggerService } = await buildService();
      mockConfigService.get.mockReturnValue(true);
      (findPlanArtifactManifestByBranchName as jest.Mock).mockReturnValue({
        sourceBranch: 'main',
        figmaLinks: [
          'https://figma.com/design/X/Page?node-id=1-1',
          'https://figma.com/design/X/Page?node-id=2-2',
        ],
      });
      mockFigmaRestClient.fetchFrames.mockResolvedValue([
        { url: 'https://figma.com/design/X/Page?node-id=1-1', name: 'F', width: 100, height: 100, screenshotUrl: 'https://img', layout: { name: 'F', width: 100, height: 100 } },
        { url: 'https://figma.com/design/X/Page?node-id=2-2', name: '', width: 0, height: 0, screenshotUrl: '', layout: { name: '' } },
      ]);
      const onProgress = jest.fn();

      await service.resolveIfEnabled({ repoDir: '/repo', force: true, onProgress });

      expect(mockLoggerService.warn).not.toHaveBeenCalled();
      expect(onProgress).not.toHaveBeenCalled();
    });

    it('warns via the overrideLinks branch when all frame fetches return []', async () => {
      const { service, mockLoggerService } = await buildService();
      const overrideLinks = ['https://figma.com/design/A/Page?node-id=2-3'];
      mockFigmaRestClient.fetchFrames.mockResolvedValue([]);
      const onProgress = jest.fn();

      const result = await service.resolveIfEnabled({ repoDir: '/repo', force: true, overrideLinks, onProgress });

      expect(result?.frames).toEqual([]);
      expect(mockLoggerService.warn).toHaveBeenCalledTimes(1);
      expect(onProgress).toHaveBeenCalledTimes(1);
      expect(findPlanArtifactManifestByBranchName).not.toHaveBeenCalled();
    });

    it('loads manifest by artifact path when artifactPath is set, skipping branch lookup', async () => {
      const { service, mockGitService } = await buildService();
      (readPlanArtifactManifest as jest.Mock).mockReturnValue({
        artifactPath: '/artifacts/2026-09-08-abc-fix-plan.json',
        action: 'fix',
        createdAt: '2026-09-08T00:00:00.000Z',
        format: 'json',
        hash: 'abc123',
        sourceKind: 'ticket',
        sourceName: 'PROJ-1',
        figmaLinks: ['https://www.figma.com/design/UZuMQg4xXa9cXvIPnghyz9/Stories-Feed?node-id=1-1'],
        sourceBranch: 'main',
      });
      mockFigmaRestClient.fetchFrames.mockResolvedValue([
        { url: 'https://www.figma.com/design/UZuMQg4xXa9cXvIPnghyz9/Stories-Feed?node-id=1-1', name: 'Feed Frame', width: 800, height: 600, screenshotUrl: 'https://s3.example.com/img.png', layout: { name: 'Feed Frame', width: 800, height: 600 } },
      ]);

      const result = await service.resolveIfEnabled({
        repoDir: '/repo',
        force: false,
        artifactPath: '/artifacts/2026-09-08-abc-fix-plan.json',
      });

      expect(readPlanArtifactManifest).toHaveBeenCalledWith(expect.stringContaining('.sources.json'));
      expect(findPlanArtifactManifestByBranchName).not.toHaveBeenCalled();
      expect(mockGitService.getBranchInfo).not.toHaveBeenCalled();
      expect(result).toMatchObject({
        figmaLinks: ['https://www.figma.com/design/UZuMQg4xXa9cXvIPnghyz9/Stories-Feed?node-id=1-1'],
        baseBranch: 'main',
      });
    });
  });
});
