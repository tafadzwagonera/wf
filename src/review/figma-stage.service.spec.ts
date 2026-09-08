jest.mock('../shared/utils/plan-artifact', () => {
  const actual = jest.requireActual('../shared/utils/plan-artifact');
  return {
    ...actual,
    findPlanArtifactManifestByBranchName: jest.fn().mockReturnValue(undefined),
  };
});

import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { FigmaStageService } from './figma-stage.service';
import { FigmaRestClient } from '../integrations/figma/figma-rest.client';
import { GitService } from '../integrations/git/git.service';
import { LoggerService } from '../shared/logger/logger.service';
import { findPlanArtifactManifestByBranchName } from '../shared/utils/plan-artifact';

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
        { url: 'https://figma.com/design/X/Page?node-id=1-1', name: 'F', width: 100, height: 100, screenshotUrl: 'https://img' },
      ]);
      const result = await service.resolveIfEnabled({ repoDir: '/repo', force: true });
      expect(result).toEqual({
        figmaLinks: ['https://figma.com/design/X/Page?node-id=1-1'],
        baseBranch: 'main',
        frames: [{ url: 'https://figma.com/design/X/Page?node-id=1-1', name: 'F', width: 100, height: 100, screenshotUrl: 'https://img' }],
      });
    });

    it('skips manifest lookup and uses overrideLinks when provided', async () => {
      const { service } = await buildService();
      const overrideLinks = ['https://figma.com/design/A/Page?node-id=2-3'];
      mockFigmaRestClient.fetchFrames.mockResolvedValue([
        { url: overrideLinks[0], name: 'Override', width: 200, height: 300, screenshotUrl: 'https://img2' },
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
        { url: 'https://figma.com/design/X/Page?node-id=1-1', name: 'F', width: 100, height: 100, screenshotUrl: 'https://img' },
        { url: 'https://figma.com/design/X/Page?node-id=2-2', name: '', width: 0, height: 0, screenshotUrl: '' },
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
  });
});
