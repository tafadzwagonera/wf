jest.mock('./sonar-scanner', () => ({
  runSonarScan: jest.fn().mockResolvedValue({ status: 'clean', steps: [] }),
}));

jest.mock('../shared/utils/plan-artifact', () => {
  const actual = jest.requireActual('../shared/utils/plan-artifact');
  return {
    ...actual,
    findPlanArtifactManifestByBranchName: jest.fn().mockReturnValue(undefined),
    updatePlanArtifactManifestSourceBranch: jest.fn(),
  };
});

jest.mock('../shared/utils/source-branch-prompt', () => ({
  promptForSourceBranch: jest.fn().mockResolvedValue(undefined),
}));

import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { SonarStageService } from './sonar-stage.service';
import { GitService } from '../integrations/git/git.service';
import { SessionService } from '../shared/session/session.service';
import { LoggerService } from '../shared/logger/logger.service';
import { runSonarScan } from './sonar-scanner';
import {
  findPlanArtifactManifestByBranchName,
  updatePlanArtifactManifestSourceBranch,
} from '../shared/utils/plan-artifact';
import { promptForSourceBranch } from '../shared/utils/source-branch-prompt';

const setInteractiveSession = (): void => {
  Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
  Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
};

const setNonInteractiveSession = (): void => {
  Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
  Object.defineProperty(process.stdout, 'isTTY', { value: false, configurable: true });
};

async function buildService() {
  const mockConfigService = { get: jest.fn().mockReturnValue(undefined) };
  const mockGitService = {
    getStatus: jest.fn().mockResolvedValue({ staged: ['src/auth.ts'] }),
    getBranchInfo: jest.fn().mockResolvedValue({
      current: 'feature/x', development: 'develop', all: [], isClean: true, hasUncommittedChanges: false,
    }),
    getMergeBase: jest.fn().mockResolvedValue('mock-merge-base-sha'),
    getUpstreamRef: jest.fn().mockResolvedValue(null),
    detectDevelopmentBranches: jest.fn().mockReturnValue([]),
    detectMainBranch: jest.fn().mockReturnValue(undefined),
    getBranchCreationSource: jest.fn().mockResolvedValue(null),
    getChangedFilesSince: jest.fn().mockResolvedValue([]),
  };
  const mockSessionService = {
    findByTicketKey: jest.fn().mockResolvedValue(null),
    findByProviderSessionId: jest.fn().mockResolvedValue(null),
  };
  const mockLoggerService = { warn: jest.fn(), error: jest.fn(), info: jest.fn() };

  const module = await Test.createTestingModule({
    providers: [
      SonarStageService,
      { provide: ConfigService, useValue: mockConfigService },
      { provide: GitService, useValue: mockGitService },
      { provide: SessionService, useValue: mockSessionService },
      { provide: LoggerService, useValue: mockLoggerService },
    ],
  }).compile();

  return {
    service: module.get(SonarStageService),
    mockConfigService,
    mockGitService,
    mockSessionService,
    mockLoggerService,
  };
}

describe('SonarStageService', () => {
  afterEach(() => {
    setNonInteractiveSession();
    jest.restoreAllMocks();
    jest.clearAllMocks();
  });

  describe('scanIfEnabled', () => {
    it('returns undefined when force is falsy and config is not true', async () => {
      const { service, mockConfigService } = await buildService();
      mockConfigService.get.mockReturnValue(undefined);

      const result = await service.scanIfEnabled({ repoDir: '/repo' });

      expect(result).toBeUndefined();
    });

    it('does not call the prompt when allowPrompt is false even in a TTY', async () => {
      setInteractiveSession();
      const { service, mockConfigService, mockGitService } = await buildService();
      mockConfigService.get.mockReturnValue(true);
      mockGitService.getStatus.mockResolvedValue({ staged: [] });
      const mockRunSonar = runSonarScan as jest.MockedFunction<typeof runSonarScan>;
      mockRunSonar.mockResolvedValue({ status: 'clean', steps: [] });
      const mockPrompt = promptForSourceBranch as jest.MockedFunction<typeof promptForSourceBranch>;

      await service.scanIfEnabled({ repoDir: '/repo', allowPrompt: false });

      expect(mockPrompt).not.toHaveBeenCalled();
    });

    it('defaults allowPrompt to false (no prompt even with TTY when field omitted)', async () => {
      setInteractiveSession();
      const { service, mockConfigService, mockGitService } = await buildService();
      mockConfigService.get.mockReturnValue(true);
      mockGitService.getStatus.mockResolvedValue({ staged: [] });
      const mockRunSonar = runSonarScan as jest.MockedFunction<typeof runSonarScan>;
      mockRunSonar.mockResolvedValue({ status: 'clean', steps: [] });
      const mockPrompt = promptForSourceBranch as jest.MockedFunction<typeof promptForSourceBranch>;

      await service.scanIfEnabled({ repoDir: '/repo' });

      expect(mockPrompt).not.toHaveBeenCalled();
    });

    it('runs merge-base scan (Tier B) for ticketKey with recorded session when allowPrompt is false', async () => {
      const { service, mockConfigService, mockSessionService, mockGitService } = await buildService();
      mockConfigService.get.mockReturnValue(true);
      mockGitService.getStatus.mockResolvedValue({ staged: [] });
      mockGitService.getBranchInfo.mockResolvedValue({
        current: 'feature/WBP-1', development: 'develop', all: [], isClean: true, hasUncommittedChanges: false,
      });
      mockGitService.getMergeBase.mockResolvedValue('deadbeef');
      mockSessionService.findByTicketKey.mockResolvedValue({ sourceBranch: 'feature/WBP-1' });
      const mockRunSonar = runSonarScan as jest.MockedFunction<typeof runSonarScan>;
      mockRunSonar.mockResolvedValue({ status: 'clean', steps: [] });

      const result = await service.scanIfEnabled({ repoDir: '/repo', ticketKey: 'WBP-1', allowPrompt: false });

      expect(mockRunSonar).toHaveBeenCalledWith(
        expect.objectContaining({ scope: expect.objectContaining({ kind: 'base' }) }),
      );
      expect(result).toEqual({ status: 'clean', steps: [] });
    });

    it('skips the SonarQube CLI scan when review sonar config is undefined', async () => {
      const { service } = await buildService();
      const mockRunSonar = runSonarScan as jest.MockedFunction<typeof runSonarScan>;
      mockRunSonar.mockClear();

      await service.scanIfEnabled({ repoDir: '/tmp/repo', allowPrompt: true });

      expect(mockRunSonar).not.toHaveBeenCalled();
    });

    it('runs the SonarQube CLI scan when the --sonar flag is set and config is undefined', async () => {
      const { service } = await buildService();
      const mockRunSonar = runSonarScan as jest.MockedFunction<typeof runSonarScan>;
      mockRunSonar.mockClear();
      mockRunSonar.mockResolvedValue({ status: 'clean', steps: [] });

      await service.scanIfEnabled({ repoDir: '/tmp/repo', force: true, allowPrompt: true });

      expect(mockRunSonar).toHaveBeenCalledWith({
        repoDir: '/tmp/repo', scope: { kind: 'staged' }, secretPaths: ['src/auth.ts'], onProgress: undefined,
      });
    });

    it('falls back to a merge-base diff scope when nothing is staged but the branch has diverged', async () => {
      const { service, mockGitService } = await buildService();
      const mockRunSonar = runSonarScan as jest.MockedFunction<typeof runSonarScan>;
      mockRunSonar.mockClear();
      mockGitService.getStatus.mockResolvedValue({ staged: [] });
      mockGitService.getBranchInfo.mockResolvedValue({
        current: 'feature/WBP-1-thing', development: 'develop', all: [], isClean: true, hasUncommittedChanges: false,
      });
      mockGitService.getMergeBase.mockResolvedValue('44ad52b2cba1142af84c8162d236bc0dd2791132');

      await service.scanIfEnabled({ repoDir: '/tmp/repo', force: true, allowPrompt: true });

      expect(mockGitService.getMergeBase).toHaveBeenCalledWith('develop', 'feature/WBP-1-thing', '/tmp/repo');
      expect(mockRunSonar).toHaveBeenCalledWith({
        repoDir: '/tmp/repo',
        scope: { kind: 'base', ref: '44ad52b2cba1142af84c8162d236bc0dd2791132' },
        secretPaths: [],
        onProgress: undefined,
      });
    });

    it('scopes the secrets scan to the files changed since the merge-base, in the merge-base fallback path', async () => {
      const { service, mockGitService } = await buildService();
      const mockRunSonar = runSonarScan as jest.MockedFunction<typeof runSonarScan>;
      mockRunSonar.mockClear();
      mockGitService.getStatus.mockResolvedValue({ staged: [] });
      mockGitService.getBranchInfo.mockResolvedValue({
        current: 'feature/WBP-1-thing', development: 'develop', all: [], isClean: true, hasUncommittedChanges: false,
      });
      mockGitService.getMergeBase.mockResolvedValue('44ad52b2cba1142af84c8162d236bc0dd2791132');
      mockGitService.getChangedFilesSince.mockResolvedValue(['src/auth.ts', 'src/secrets.ts']);

      await service.scanIfEnabled({ repoDir: '/tmp/repo', force: true, allowPrompt: true });

      expect(mockGitService.getChangedFilesSince).toHaveBeenCalledWith(
        '44ad52b2cba1142af84c8162d236bc0dd2791132', '/tmp/repo'
      );
      expect(mockRunSonar).toHaveBeenCalledWith({
        repoDir: '/tmp/repo',
        scope: { kind: 'base', ref: '44ad52b2cba1142af84c8162d236bc0dd2791132' },
        secretPaths: ['src/auth.ts', 'src/secrets.ts'],
        onProgress: undefined,
      });
    });

    it('runs a bare analyze when nothing is staged, on a trunk branch, with no upstream', async () => {
      const { service, mockGitService } = await buildService();
      const mockRunSonar = runSonarScan as jest.MockedFunction<typeof runSonarScan>;
      mockRunSonar.mockClear();
      mockGitService.getStatus.mockResolvedValue({ staged: [] });
      mockGitService.getBranchInfo.mockResolvedValue({
        current: 'develop', development: 'develop', all: [], isClean: true, hasUncommittedChanges: false,
      });
      mockGitService.getUpstreamRef.mockResolvedValue(null);
      const onProgress = jest.fn();

      await service.scanIfEnabled({ repoDir: '/tmp/repo', force: true, allowPrompt: true, onProgress });

      expect(mockRunSonar).toHaveBeenCalledWith({
        repoDir: '/tmp/repo', scope: { kind: 'branch' }, secretPaths: [], onProgress,
      });
      expect(onProgress).toHaveBeenCalledWith(
        'SonarQube CLI: no base branch to diff against — running a bare analyze instead'
      );
    });

    it('falls back to a merge-base-against-upstream diff scope when working directly on a trunk branch', async () => {
      const { service, mockGitService } = await buildService();
      const mockRunSonar = runSonarScan as jest.MockedFunction<typeof runSonarScan>;
      mockRunSonar.mockClear();
      mockGitService.getStatus.mockResolvedValue({ staged: [] });
      mockGitService.getBranchInfo.mockResolvedValue({
        current: 'develop', development: 'develop', all: [], isClean: true, hasUncommittedChanges: false,
      });
      mockGitService.getUpstreamRef.mockResolvedValue('origin/develop');
      mockGitService.getMergeBase.mockResolvedValue('44ad52b2cba1142af84c8162d236bc0dd2791132');

      await service.scanIfEnabled({ repoDir: '/tmp/repo', force: true, allowPrompt: true });

      expect(mockGitService.getUpstreamRef).toHaveBeenCalledWith('develop', '/tmp/repo');
      expect(mockGitService.getMergeBase).toHaveBeenCalledWith('origin/develop', 'develop', '/tmp/repo');
      expect(mockRunSonar).toHaveBeenCalledWith({
        repoDir: '/tmp/repo',
        scope: { kind: 'base', ref: '44ad52b2cba1142af84c8162d236bc0dd2791132' },
        secretPaths: [],
        onProgress: undefined,
      });
    });

    it('Tier B: uses the session recorded for a bare ticket key, bypassing manifest/reflog/prompt', async () => {
      const { service, mockGitService, mockSessionService } = await buildService();
      const mockRunSonar = runSonarScan as jest.MockedFunction<typeof runSonarScan>;
      mockRunSonar.mockClear();
      mockSessionService.findByTicketKey.mockResolvedValue({ sourceBranch: 'release/2026' });
      mockGitService.getStatus.mockResolvedValue({ staged: [] });
      mockGitService.getBranchInfo.mockResolvedValue({
        current: 'master', development: 'develop', all: [], isClean: true, hasUncommittedChanges: false,
      });
      mockGitService.getMergeBase.mockResolvedValue('deadbeef');
      const mockFindByBranchName
        = findPlanArtifactManifestByBranchName as jest.MockedFunction<typeof findPlanArtifactManifestByBranchName>;
      const mockPrompt = promptForSourceBranch as jest.MockedFunction<typeof promptForSourceBranch>;

      await service.scanIfEnabled({ repoDir: '/tmp/repo', force: true, ticketKey: 'WBP-1', allowPrompt: true });

      expect(mockSessionService.findByTicketKey).toHaveBeenCalledWith('WBP-1');
      expect(mockFindByBranchName).not.toHaveBeenCalled();
      expect(mockGitService.getBranchCreationSource).not.toHaveBeenCalled();
      expect(mockPrompt).not.toHaveBeenCalled();
      expect(mockGitService.getMergeBase).toHaveBeenCalledWith('release/2026', 'master', '/tmp/repo');
      expect(mockRunSonar).toHaveBeenCalledWith({
        repoDir: '/tmp/repo',
        scope: { kind: 'base', ref: 'deadbeef' },
        secretPaths: [],
        onProgress: undefined,
      });
    });

    it('Tier B: runs a bare analyze with a warn log when the ticket key has no matching session', async () => {
      const { service, mockGitService, mockSessionService, mockLoggerService } = await buildService();
      const mockRunSonar = runSonarScan as jest.MockedFunction<typeof runSonarScan>;
      mockRunSonar.mockClear();
      mockSessionService.findByTicketKey.mockResolvedValue(null);
      mockGitService.getStatus.mockResolvedValue({ staged: [] });
      mockGitService.getBranchInfo.mockResolvedValue({
        current: 'master', development: 'develop', all: [], isClean: true, hasUncommittedChanges: false,
      });
      const mockFindByBranchName
        = findPlanArtifactManifestByBranchName as jest.MockedFunction<typeof findPlanArtifactManifestByBranchName>;
      const mockPrompt = promptForSourceBranch as jest.MockedFunction<typeof promptForSourceBranch>;

      await service.scanIfEnabled({ repoDir: '/tmp/repo', force: true, ticketKey: 'WBP-1', allowPrompt: true });

      expect(mockSessionService.findByTicketKey).toHaveBeenCalledWith('WBP-1');
      expect(mockFindByBranchName).not.toHaveBeenCalled();
      expect(mockGitService.getBranchCreationSource).not.toHaveBeenCalled();
      expect(mockGitService.getMergeBase).not.toHaveBeenCalled();
      expect(mockPrompt).not.toHaveBeenCalled();
      expect(mockLoggerService.warn).toHaveBeenCalledWith(
        expect.stringContaining('bare analyze'), 'sonar-stage'
      );
      expect(mockRunSonar).toHaveBeenCalledWith({
        repoDir: '/tmp/repo', scope: { kind: 'branch' }, secretPaths: [], onProgress: undefined,
      });
    });

    it('Tier B: runs a bare analyze with a warn log when session exists but yields no merge-base', async () => {
      const { service, mockGitService, mockSessionService, mockLoggerService } = await buildService();
      const mockRunSonar = runSonarScan as jest.MockedFunction<typeof runSonarScan>;
      mockRunSonar.mockClear();
      mockSessionService.findByTicketKey.mockResolvedValue({ sourceBranch: 'release/2026' });
      mockGitService.getStatus.mockResolvedValue({ staged: [] });
      mockGitService.getBranchInfo.mockResolvedValue({
        current: 'master', development: 'develop', all: [], isClean: true, hasUncommittedChanges: false,
      });
      mockGitService.getMergeBase.mockResolvedValue(null);

      await service.scanIfEnabled({ repoDir: '/tmp/repo', force: true, ticketKey: 'WBP-1', allowPrompt: true });

      expect(mockSessionService.findByTicketKey).toHaveBeenCalledWith('WBP-1');
      expect(mockGitService.getMergeBase).toHaveBeenCalledWith('release/2026', 'master', '/tmp/repo');
      expect(mockLoggerService.warn).toHaveBeenCalledWith(
        expect.stringContaining('bare analyze'), 'sonar-stage'
      );
      expect(mockRunSonar).toHaveBeenCalledWith({
        repoDir: '/tmp/repo', scope: { kind: 'branch' }, secretPaths: [], onProgress: undefined,
      });
    });

    it('Tier A: uses the session found via providerSessionId, bypassing ticketKey/manifest', async () => {
      const { service, mockGitService, mockSessionService } = await buildService();
      const mockRunSonar = runSonarScan as jest.MockedFunction<typeof runSonarScan>;
      mockRunSonar.mockClear();
      mockSessionService.findByProviderSessionId.mockResolvedValue({ sourceBranch: 'release/2026' });
      mockGitService.getStatus.mockResolvedValue({ staged: [] });
      mockGitService.getBranchInfo.mockResolvedValue({
        current: 'master', development: 'develop', all: [], isClean: true, hasUncommittedChanges: false,
      });
      mockGitService.getMergeBase.mockResolvedValue('deadbeef');

      await service.scanIfEnabled({
        repoDir: '/tmp/repo', force: true, ticketKey: 'WBP-1', providerSessionId: 'provider-abc', allowPrompt: true,
      });

      expect(mockSessionService.findByProviderSessionId).toHaveBeenCalledWith('provider-abc', 'plan');
      expect(mockSessionService.findByTicketKey).not.toHaveBeenCalled();
      expect(findPlanArtifactManifestByBranchName).not.toHaveBeenCalled();
      expect(mockGitService.getMergeBase).toHaveBeenCalledWith('release/2026', 'master', '/tmp/repo');
      expect(mockRunSonar).toHaveBeenCalledWith({
        repoDir: '/tmp/repo',
        scope: { kind: 'base', ref: 'deadbeef' },
        secretPaths: [],
        onProgress: undefined,
      });
    });

    it('Tier A: falls through to the full Tier C chain when providerSessionId matches no session', async () => {
      const { service, mockGitService, mockSessionService } = await buildService();
      const mockRunSonar = runSonarScan as jest.MockedFunction<typeof runSonarScan>;
      mockRunSonar.mockClear();
      mockSessionService.findByProviderSessionId.mockResolvedValue(null);
      const mockFindByBranchName
        = findPlanArtifactManifestByBranchName as jest.MockedFunction<typeof findPlanArtifactManifestByBranchName>;
      mockFindByBranchName.mockReturnValueOnce(undefined);
      mockGitService.getStatus.mockResolvedValue({ staged: [] });
      mockGitService.getBranchInfo.mockResolvedValue({
        current: 'feature/WBP-1-thing', development: 'develop',
        all: ['master', 'develop', 'feature/WBP-1-thing'], isClean: true, hasUncommittedChanges: false,
      });
      mockGitService.getBranchCreationSource.mockResolvedValue('release/2026');
      mockGitService.getMergeBase.mockResolvedValue('deadbeef');

      await service.scanIfEnabled({
        repoDir: '/tmp/repo', force: true, providerSessionId: 'provider-abc', allowPrompt: true,
      });

      expect(mockSessionService.findByProviderSessionId).toHaveBeenCalledWith('provider-abc', 'plan');
      expect(mockFindByBranchName).toHaveBeenCalledWith('feature/WBP-1-thing', expect.any(Array));
      expect(mockGitService.getBranchCreationSource).toHaveBeenCalledWith('feature/WBP-1-thing', '/tmp/repo');
      expect(mockGitService.getMergeBase).toHaveBeenCalledWith('release/2026', 'feature/WBP-1-thing', '/tmp/repo');
      expect(mockRunSonar).toHaveBeenCalledWith({
        repoDir: '/tmp/repo',
        scope: { kind: 'base', ref: 'deadbeef' },
        secretPaths: [],
        onProgress: undefined,
      });
    });

    it('Tier C: prefers the session recorded for the manifest\'s own identifier over the manifest\'s sourceBranch field', async () => {
      const { service, mockGitService, mockSessionService } = await buildService();
      const mockRunSonar = runSonarScan as jest.MockedFunction<typeof runSonarScan>;
      mockRunSonar.mockClear();
      const mockFindByBranchName
        = findPlanArtifactManifestByBranchName as jest.MockedFunction<typeof findPlanArtifactManifestByBranchName>;
      mockFindByBranchName.mockReturnValueOnce({
        artifactPath: '/tmp/repo/.wf/jira/2026-08-25-abc123-feature-plan.json',
        action: 'feature', createdAt: '2026-08-25T00:00:00.000Z', format: 'json', hash: 'abc123',
        sourceKind: 'ticket', sourceName: 'WBP-1', ticketKey: 'WBP-1', sourceBranch: 'develop',
        branchName: 'feature/WBP-1-thing',
      });
      mockSessionService.findByTicketKey.mockResolvedValue({ sourceBranch: 'release/2026' });
      mockGitService.getStatus.mockResolvedValue({ staged: [] });
      mockGitService.getBranchInfo.mockResolvedValue({
        current: 'feature/WBP-1-thing', development: 'develop', all: [], isClean: true, hasUncommittedChanges: false,
      });
      mockGitService.getMergeBase.mockResolvedValue('deadbeef');

      await service.scanIfEnabled({ repoDir: '/tmp/repo', force: true, allowPrompt: true });

      expect(mockSessionService.findByTicketKey).toHaveBeenCalledWith('WBP-1');
      expect(mockGitService.getBranchCreationSource).not.toHaveBeenCalled();
      expect(mockGitService.getMergeBase).toHaveBeenCalledWith('release/2026', 'feature/WBP-1-thing', '/tmp/repo');
      expect(mockRunSonar).toHaveBeenCalledWith({
        repoDir: '/tmp/repo',
        scope: { kind: 'base', ref: 'deadbeef' },
        secretPaths: [],
        onProgress: undefined,
      });
    });

    it('Tier C: falls back to the manifest\'s own sourceBranch when its identifier has no session', async () => {
      const { service, mockGitService, mockSessionService } = await buildService();
      const mockRunSonar = runSonarScan as jest.MockedFunction<typeof runSonarScan>;
      mockRunSonar.mockClear();
      const mockFindByBranchName
        = findPlanArtifactManifestByBranchName as jest.MockedFunction<typeof findPlanArtifactManifestByBranchName>;
      mockFindByBranchName.mockReturnValueOnce({
        artifactPath: '/tmp/repo/.wf/jira/2026-08-25-abc123-feature-plan.json',
        action: 'feature', createdAt: '2026-08-25T00:00:00.000Z', format: 'json', hash: 'abc123',
        sourceKind: 'ticket', sourceName: 'WBP-1', ticketKey: 'WBP-1', sourceBranch: 'release/2026',
        branchName: 'feature/WBP-1-thing',
      });
      mockSessionService.findByTicketKey.mockResolvedValue(null);
      mockGitService.getStatus.mockResolvedValue({ staged: [] });
      mockGitService.getBranchInfo.mockResolvedValue({
        current: 'feature/WBP-1-thing', development: 'develop', all: [], isClean: true, hasUncommittedChanges: false,
      });
      mockGitService.getMergeBase.mockResolvedValue('deadbeef');

      await service.scanIfEnabled({ repoDir: '/tmp/repo', force: true, allowPrompt: true });

      expect(mockSessionService.findByTicketKey).toHaveBeenCalledWith('WBP-1');
      expect(mockGitService.getMergeBase).toHaveBeenCalledWith('release/2026', 'feature/WBP-1-thing', '/tmp/repo');
      expect(mockRunSonar).toHaveBeenCalledWith({
        repoDir: '/tmp/repo',
        scope: { kind: 'base', ref: 'deadbeef' },
        secretPaths: [],
        onProgress: undefined,
      });
    });

    it('Tier C: looks up the session for a custom plan by its sourceName, since it has no ticketKey/customArtifactName', async () => {
      const { service, mockGitService, mockSessionService } = await buildService();
      const mockRunSonar = runSonarScan as jest.MockedFunction<typeof runSonarScan>;
      mockRunSonar.mockClear();
      const mockFindByBranchName
        = findPlanArtifactManifestByBranchName as jest.MockedFunction<typeof findPlanArtifactManifestByBranchName>;
      mockFindByBranchName.mockReturnValueOnce({
        artifactPath: '/tmp/repo/.wf/custom/2026-08-25-abc123-fix-plan.json',
        action: 'fix', createdAt: '2026-08-25T00:00:00.000Z', format: 'json', hash: 'abc123',
        sourceKind: 'custom', sourceName: 'my-custom-plan', branchName: 'fix/my-custom-plan',
      });
      mockSessionService.findByTicketKey.mockResolvedValue({ sourceBranch: 'release/2026' });
      mockGitService.getStatus.mockResolvedValue({ staged: [] });
      mockGitService.getBranchInfo.mockResolvedValue({
        current: 'fix/my-custom-plan', development: 'develop', all: [], isClean: true, hasUncommittedChanges: false,
      });
      mockGitService.getMergeBase.mockResolvedValue('deadbeef');

      await service.scanIfEnabled({ repoDir: '/tmp/repo', force: true, allowPrompt: true });

      expect(mockSessionService.findByTicketKey).toHaveBeenCalledWith('my-custom-plan');
      expect(mockGitService.getBranchCreationSource).not.toHaveBeenCalled();
      expect(mockGitService.getMergeBase).toHaveBeenCalledWith('release/2026', 'fix/my-custom-plan', '/tmp/repo');
      expect(mockRunSonar).toHaveBeenCalledWith({
        repoDir: '/tmp/repo',
        scope: { kind: 'base', ref: 'deadbeef' },
        secretPaths: [],
        onProgress: undefined,
      });
    });

    it('Tier C: recovers a legacy manifest\'s source branch from git reflog before prompting', async () => {
      setInteractiveSession();
      const { service, mockGitService } = await buildService();
      const mockRunSonar = runSonarScan as jest.MockedFunction<typeof runSonarScan>;
      mockRunSonar.mockClear();
      const mockFindByBranchName
        = findPlanArtifactManifestByBranchName as jest.MockedFunction<typeof findPlanArtifactManifestByBranchName>;
      const mockUpdateSourceBranch
        = updatePlanArtifactManifestSourceBranch as jest.MockedFunction<typeof updatePlanArtifactManifestSourceBranch>;
      mockFindByBranchName.mockReturnValueOnce({
        artifactPath: '/tmp/repo/.wf/jira/2026-08-25-abc123-feature-plan.json',
        action: 'feature', createdAt: '2026-08-25T00:00:00.000Z', format: 'json', hash: 'abc123',
        sourceKind: 'ticket', sourceName: 'WBP-1', ticketKey: 'WBP-1', branchName: 'feature/WBP-1-thing',
      });
      mockGitService.getStatus.mockResolvedValue({ staged: [] });
      mockGitService.getBranchInfo.mockResolvedValue({
        current: 'feature/WBP-1-thing', development: 'develop',
        all: ['master', 'develop', 'feature/WBP-1-thing'], isClean: true, hasUncommittedChanges: false,
      });
      mockGitService.getBranchCreationSource.mockResolvedValue('release/2026');
      mockGitService.getMergeBase.mockResolvedValue('deadbeef');
      const mockPrompt = promptForSourceBranch as jest.MockedFunction<typeof promptForSourceBranch>;

      await service.scanIfEnabled({ repoDir: '/tmp/repo', force: true, allowPrompt: true });

      expect(mockGitService.getBranchCreationSource).toHaveBeenCalledWith('feature/WBP-1-thing', '/tmp/repo');
      expect(mockPrompt).not.toHaveBeenCalled();
      expect(mockUpdateSourceBranch).toHaveBeenCalledWith(
        '/tmp/repo/.wf/jira/2026-08-25-abc123-feature-plan.json', 'release/2026', 'feature/WBP-1-thing'
      );
      expect(mockGitService.getMergeBase).toHaveBeenCalledWith('release/2026', 'feature/WBP-1-thing', '/tmp/repo');
      expect(mockRunSonar).toHaveBeenCalledWith({
        repoDir: '/tmp/repo',
        scope: { kind: 'base', ref: 'deadbeef' },
        secretPaths: [],
        onProgress: undefined,
      });
    });

    it('finds a custom plan\'s manifest by branch name, since it has no ticket key to search by', async () => {
      const { service, mockGitService } = await buildService();
      const mockRunSonar = runSonarScan as jest.MockedFunction<typeof runSonarScan>;
      mockRunSonar.mockClear();
      const mockFindByBranchName
        = findPlanArtifactManifestByBranchName as jest.MockedFunction<typeof findPlanArtifactManifestByBranchName>;
      mockFindByBranchName.mockReturnValueOnce({
        artifactPath: '/tmp/repo/.wf/custom/2026-08-25-abc123-fix-plan.json',
        action: 'fix', createdAt: '2026-08-25T00:00:00.000Z', format: 'json', hash: 'abc123',
        sourceKind: 'custom', sourceName: 'my-custom-plan', sourceBranch: 'release/2026',
        branchName: 'fix/my-custom-plan',
      });
      mockGitService.getStatus.mockResolvedValue({ staged: [] });
      mockGitService.getBranchInfo.mockResolvedValue({
        current: 'fix/my-custom-plan', development: 'develop', all: [], isClean: true, hasUncommittedChanges: false,
      });
      mockGitService.getMergeBase.mockResolvedValue('deadbeef');

      await service.scanIfEnabled({ repoDir: '/tmp/repo', force: true, allowPrompt: true });

      expect(mockFindByBranchName).toHaveBeenCalledWith('fix/my-custom-plan', expect.any(Array));
      expect(mockFindByBranchName.mock.calls[0][1].length).toBeGreaterThanOrEqual(1);
      expect(mockGitService.getMergeBase).toHaveBeenCalledWith('release/2026', 'fix/my-custom-plan', '/tmp/repo');
      expect(mockRunSonar).toHaveBeenCalledWith({
        repoDir: '/tmp/repo',
        scope: { kind: 'base', ref: 'deadbeef' },
        secretPaths: [],
        onProgress: undefined,
      });
    });

    it('prompts to disambiguate the source branch when interactive, even with no ticket key or manifest', async () => {
      setInteractiveSession();
      const { service, mockGitService } = await buildService();
      const mockRunSonar = runSonarScan as jest.MockedFunction<typeof runSonarScan>;
      mockRunSonar.mockClear();
      const mockUpdateSourceBranch
        = updatePlanArtifactManifestSourceBranch as jest.MockedFunction<typeof updatePlanArtifactManifestSourceBranch>;
      const mockPrompt = promptForSourceBranch as jest.MockedFunction<typeof promptForSourceBranch>;
      mockPrompt.mockResolvedValue('release/2026');
      mockGitService.getStatus.mockResolvedValue({ staged: [] });
      mockGitService.getBranchInfo.mockResolvedValue({
        current: 'master', development: 'develop',
        all: ['master', 'develop', 'release/2026'], isClean: true, hasUncommittedChanges: false,
      });
      mockGitService.detectDevelopmentBranches.mockReturnValue(['develop', 'release/2026']);
      mockGitService.getMergeBase.mockResolvedValue('deadbeef');

      await service.scanIfEnabled({ repoDir: '/tmp/repo', force: true, allowPrompt: true });

      expect(mockPrompt).toHaveBeenCalled();
      expect(mockGitService.getMergeBase).toHaveBeenCalledWith('release/2026', 'master', '/tmp/repo');
      expect(mockRunSonar).toHaveBeenCalledWith({
        repoDir: '/tmp/repo',
        scope: { kind: 'base', ref: 'deadbeef' },
        secretPaths: [],
        onProgress: undefined,
      });
      expect(mockUpdateSourceBranch).not.toHaveBeenCalled();
    });

    it('recovers the source branch from reflog when interactive is not required, even with no ticket key', async () => {
      const { service, mockGitService } = await buildService();
      const mockRunSonar = runSonarScan as jest.MockedFunction<typeof runSonarScan>;
      mockRunSonar.mockClear();
      const mockUpdateSourceBranch
        = updatePlanArtifactManifestSourceBranch as jest.MockedFunction<typeof updatePlanArtifactManifestSourceBranch>;
      const mockPrompt = promptForSourceBranch as jest.MockedFunction<typeof promptForSourceBranch>;
      mockGitService.getStatus.mockResolvedValue({ staged: [] });
      mockGitService.getBranchInfo.mockResolvedValue({
        current: 'feature/WBP-1-thing', development: 'develop',
        all: ['master', 'develop', 'release/2026'], isClean: true, hasUncommittedChanges: false,
      });
      mockGitService.getBranchCreationSource.mockResolvedValue('release/2026');
      mockGitService.getMergeBase.mockResolvedValue('deadbeef');

      await service.scanIfEnabled({ repoDir: '/tmp/repo', force: true, allowPrompt: true });

      expect(mockGitService.getBranchCreationSource).toHaveBeenCalledWith('feature/WBP-1-thing', '/tmp/repo');
      expect(mockPrompt).not.toHaveBeenCalled();
      expect(mockUpdateSourceBranch).not.toHaveBeenCalled();
      expect(mockGitService.getMergeBase).toHaveBeenCalledWith('release/2026', 'feature/WBP-1-thing', '/tmp/repo');
      expect(mockRunSonar).toHaveBeenCalledWith({
        repoDir: '/tmp/repo',
        scope: { kind: 'base', ref: 'deadbeef' },
        secretPaths: [],
        onProgress: undefined,
      });
    });

    it('backfills a legacy manifest missing sourceBranch by prompting when interactive', async () => {
      setInteractiveSession();
      const { service, mockGitService } = await buildService();
      const mockRunSonar = runSonarScan as jest.MockedFunction<typeof runSonarScan>;
      mockRunSonar.mockClear();
      const mockFindByBranchName
        = findPlanArtifactManifestByBranchName as jest.MockedFunction<typeof findPlanArtifactManifestByBranchName>;
      const mockUpdateSourceBranch
        = updatePlanArtifactManifestSourceBranch as jest.MockedFunction<typeof updatePlanArtifactManifestSourceBranch>;
      mockFindByBranchName.mockReturnValueOnce({
        artifactPath: '/tmp/repo/.wf/jira/2026-08-25-abc123-feature-plan.json',
        action: 'feature', createdAt: '2026-08-25T00:00:00.000Z', format: 'json', hash: 'abc123',
        sourceKind: 'ticket', sourceName: 'WBP-1', ticketKey: 'WBP-1', branchName: 'master',
      });
      const mockPrompt = promptForSourceBranch as jest.MockedFunction<typeof promptForSourceBranch>;
      mockPrompt.mockResolvedValue('release/2026');
      mockGitService.getStatus.mockResolvedValue({ staged: [] });
      mockGitService.getBranchInfo.mockResolvedValue({
        current: 'master', development: 'develop',
        all: ['master', 'develop', 'release/2026'], isClean: true, hasUncommittedChanges: false,
      });
      mockGitService.detectDevelopmentBranches.mockReturnValue(['develop', 'release/2026']);
      mockGitService.getMergeBase.mockResolvedValue('deadbeef');

      await service.scanIfEnabled({ repoDir: '/tmp/repo', force: true, allowPrompt: true });

      expect(mockUpdateSourceBranch).toHaveBeenCalledWith(
        '/tmp/repo/.wf/jira/2026-08-25-abc123-feature-plan.json', 'release/2026', 'master'
      );
      expect(mockGitService.getMergeBase).toHaveBeenCalledWith('release/2026', 'master', '/tmp/repo');
      expect(mockRunSonar).toHaveBeenCalledWith({
        repoDir: '/tmp/repo',
        scope: { kind: 'base', ref: 'deadbeef' },
        secretPaths: [],
        onProgress: undefined,
      });
    });

    it('still prompts to backfill a legacy manifest when silent=true equivalent, as long as a TTY is available', async () => {
      setInteractiveSession();
      const { service, mockGitService } = await buildService();
      const mockRunSonar = runSonarScan as jest.MockedFunction<typeof runSonarScan>;
      mockRunSonar.mockClear();
      const mockFindByBranchName
        = findPlanArtifactManifestByBranchName as jest.MockedFunction<typeof findPlanArtifactManifestByBranchName>;
      const mockUpdateSourceBranch
        = updatePlanArtifactManifestSourceBranch as jest.MockedFunction<typeof updatePlanArtifactManifestSourceBranch>;
      mockFindByBranchName.mockReturnValueOnce({
        artifactPath: '/tmp/repo/.wf/jira/2026-08-25-abc123-feature-plan.json',
        action: 'feature', createdAt: '2026-08-25T00:00:00.000Z', format: 'json', hash: 'abc123',
        sourceKind: 'ticket', sourceName: 'WBP-1', ticketKey: 'WBP-1', branchName: 'master',
      });
      const mockPrompt = promptForSourceBranch as jest.MockedFunction<typeof promptForSourceBranch>;
      mockPrompt.mockResolvedValue('release/2026');
      mockGitService.getStatus.mockResolvedValue({ staged: [] });
      mockGitService.getBranchInfo.mockResolvedValue({
        current: 'master', development: 'develop',
        all: ['master', 'develop', 'release/2026'], isClean: true, hasUncommittedChanges: false,
      });
      mockGitService.detectDevelopmentBranches.mockReturnValue(['develop', 'release/2026']);
      mockGitService.getMergeBase.mockResolvedValue('deadbeef');

      await service.scanIfEnabled({ repoDir: '/tmp/repo', force: true, allowPrompt: true });

      expect(mockPrompt).toHaveBeenCalled();
      expect(mockUpdateSourceBranch).toHaveBeenCalledWith(
        '/tmp/repo/.wf/jira/2026-08-25-abc123-feature-plan.json', 'release/2026', 'master'
      );
      expect(mockGitService.getMergeBase).toHaveBeenCalledWith('release/2026', 'master', '/tmp/repo');
    });

    it('recovers a legacy manifest\'s source branch from git reflog even in a non-interactive session', async () => {
      setNonInteractiveSession();
      const { service, mockGitService } = await buildService();
      const mockRunSonar = runSonarScan as jest.MockedFunction<typeof runSonarScan>;
      mockRunSonar.mockClear();
      const mockFindByBranchName
        = findPlanArtifactManifestByBranchName as jest.MockedFunction<typeof findPlanArtifactManifestByBranchName>;
      const mockUpdateSourceBranch
        = updatePlanArtifactManifestSourceBranch as jest.MockedFunction<typeof updatePlanArtifactManifestSourceBranch>;
      mockFindByBranchName.mockReturnValueOnce({
        artifactPath: '/tmp/repo/.wf/jira/2026-08-25-abc123-feature-plan.json',
        action: 'feature', createdAt: '2026-08-25T00:00:00.000Z', format: 'json', hash: 'abc123',
        sourceKind: 'ticket', sourceName: 'WBP-1', ticketKey: 'WBP-1', branchName: 'feature/WBP-1-thing',
      });
      const mockPrompt = promptForSourceBranch as jest.MockedFunction<typeof promptForSourceBranch>;
      mockGitService.getStatus.mockResolvedValue({ staged: [] });
      mockGitService.getBranchInfo.mockResolvedValue({
        current: 'feature/WBP-1-thing', development: 'develop',
        all: ['master', 'develop', 'feature/WBP-1-thing'], isClean: true, hasUncommittedChanges: false,
      });
      mockGitService.getBranchCreationSource.mockResolvedValue('release/2026');
      mockGitService.getMergeBase.mockResolvedValue('deadbeef');

      await service.scanIfEnabled({ repoDir: '/tmp/repo', force: true, allowPrompt: false });

      expect(mockPrompt).not.toHaveBeenCalled();
      expect(mockUpdateSourceBranch).toHaveBeenCalledWith(
        '/tmp/repo/.wf/jira/2026-08-25-abc123-feature-plan.json', 'release/2026', 'feature/WBP-1-thing'
      );
      expect(mockGitService.getMergeBase).toHaveBeenCalledWith('release/2026', 'feature/WBP-1-thing', '/tmp/repo');
    });

    it('does not prompt to backfill a legacy manifest in a non-interactive session', async () => {
      setNonInteractiveSession();
      const { service, mockGitService } = await buildService();
      const mockRunSonar = runSonarScan as jest.MockedFunction<typeof runSonarScan>;
      mockRunSonar.mockClear();
      const mockFindByBranchName
        = findPlanArtifactManifestByBranchName as jest.MockedFunction<typeof findPlanArtifactManifestByBranchName>;
      const mockUpdateSourceBranch
        = updatePlanArtifactManifestSourceBranch as jest.MockedFunction<typeof updatePlanArtifactManifestSourceBranch>;
      mockFindByBranchName.mockReturnValueOnce({
        artifactPath: '/tmp/repo/.wf/jira/2026-08-25-abc123-feature-plan.json',
        action: 'feature', createdAt: '2026-08-25T00:00:00.000Z', format: 'json', hash: 'abc123',
        sourceKind: 'ticket', sourceName: 'WBP-1', ticketKey: 'WBP-1', branchName: 'master',
      });
      const mockPrompt = promptForSourceBranch as jest.MockedFunction<typeof promptForSourceBranch>;
      mockGitService.getStatus.mockResolvedValue({ staged: [] });
      mockGitService.getBranchInfo.mockResolvedValue({
        current: 'master', development: 'develop',
        all: ['master', 'develop', 'release/2026'], isClean: true, hasUncommittedChanges: false,
      });
      mockGitService.detectDevelopmentBranches.mockReturnValue(['develop', 'release/2026']);
      mockGitService.getMergeBase.mockResolvedValue('deadbeef');

      await service.scanIfEnabled({ repoDir: '/tmp/repo', force: true, allowPrompt: false });

      expect(mockPrompt).not.toHaveBeenCalled();
      expect(mockUpdateSourceBranch).not.toHaveBeenCalled();
      expect(mockGitService.getMergeBase).toHaveBeenCalledWith('develop', 'master', '/tmp/repo');
    });

    it('runs a bare analyze when the branch and its base share no merge-base', async () => {
      const { service, mockGitService } = await buildService();
      const mockRunSonar = runSonarScan as jest.MockedFunction<typeof runSonarScan>;
      mockRunSonar.mockClear();
      mockGitService.getStatus.mockResolvedValue({ staged: [] });
      mockGitService.getBranchInfo.mockResolvedValue({
        current: 'feature/WBP-1-thing', development: 'develop', all: [], isClean: true, hasUncommittedChanges: false,
      });
      mockGitService.getMergeBase.mockResolvedValue(null);
      const onProgress = jest.fn();

      await service.scanIfEnabled({ repoDir: '/tmp/repo', force: true, allowPrompt: true, onProgress });

      expect(mockRunSonar).toHaveBeenCalledWith({
        repoDir: '/tmp/repo', scope: { kind: 'branch' }, secretPaths: [], onProgress,
      });
      expect(onProgress).toHaveBeenCalledWith(
        'SonarQube CLI: no base branch to diff against — running a bare analyze instead'
      );
    });

    it('logs a WARN via LoggerService when the source branch cannot be recovered', async () => {
      const { service, mockGitService, mockLoggerService } = await buildService();
      const mockRunSonar = runSonarScan as jest.MockedFunction<typeof runSonarScan>;
      mockRunSonar.mockClear();
      mockGitService.getStatus.mockResolvedValue({ staged: [] });
      mockGitService.getBranchInfo.mockResolvedValue({
        current: 'feature/WBP-1-thing', development: 'develop', all: [], isClean: true, hasUncommittedChanges: false,
      });
      mockGitService.getMergeBase.mockResolvedValue(null);

      await service.scanIfEnabled({ repoDir: '/tmp/repo', force: true, allowPrompt: true });

      expect(mockLoggerService.warn).toHaveBeenCalledWith(
        'SonarQube CLI: no base branch to diff against — running a bare analyze instead',
        'sonar-stage'
      );
    });

    it('logs a WARN and still scans when the recorded source-branch lookup fails', async () => {
      const { service, mockGitService, mockSessionService, mockLoggerService } = await buildService();
      const mockRunSonar = runSonarScan as jest.MockedFunction<typeof runSonarScan>;
      mockRunSonar.mockClear();
      mockGitService.getStatus.mockResolvedValue({ staged: [] });
      mockGitService.getBranchInfo.mockResolvedValue({
        current: 'feature/WBP-1-thing', development: 'develop', all: [], isClean: true, hasUncommittedChanges: false,
      });
      mockSessionService.findByProviderSessionId.mockRejectedValue(new Error('session store unreadable'));

      await service.scanIfEnabled({
        repoDir: '/tmp/repo', force: true, providerSessionId: 'sess-1', allowPrompt: false,
      });

      expect(mockLoggerService.warn).toHaveBeenCalledWith(
        'SonarQube CLI: recorded source-branch lookup failed (session store unreadable) — '
        + 'falling back to the development or upstream branch',
        'sonar-stage'
      );
      expect(mockRunSonar).toHaveBeenCalledTimes(1);
    });
  });
});
