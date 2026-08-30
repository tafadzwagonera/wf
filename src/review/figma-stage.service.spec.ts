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
import { GitService } from '../integrations/git/git.service';
import { LoggerService } from '../shared/logger/logger.service';
import { findPlanArtifactManifestByBranchName } from '../shared/utils/plan-artifact';

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
  });

  describe('resolveIfEnabled', () => {
    it('returns undefined when config is false and force is false', async () => {
      const { service, mockConfigService } = await buildService();
      mockConfigService.get.mockReturnValue(false);
      const result = await service.resolveIfEnabled({ repoDir: '/repo', force: false });
      expect(result).toBeUndefined();
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

    it('returns figmaLinks and baseBranch when manifest has links', async () => {
      const { service, mockConfigService } = await buildService();
      mockConfigService.get.mockReturnValue(true);
      (findPlanArtifactManifestByBranchName as jest.Mock).mockReturnValue({
        sourceBranch: 'main',
        figmaLinks: ['https://figma.com/design/X/Page'],
      });
      const result = await service.resolveIfEnabled({ repoDir: '/repo', force: true });
      expect(result).toEqual({
        figmaLinks: ['https://figma.com/design/X/Page'],
        baseBranch: 'main',
      });
    });
  });
});
