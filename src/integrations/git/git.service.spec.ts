import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import type { StatusResult } from 'simple-git';
import { GitService } from './git.service';
import { LoggerService } from '../../common/logger/logger.service';
import { GitError, InvalidBranchNameError } from '../../common/errors/app.error';

const mockCwdGitInstance = {
  reset: jest.fn(),
  raw: jest.fn(),
  status: jest.fn(),
  add: jest.fn(),
  commit: jest.fn(),
  env: jest.fn().mockReturnThis(),
};

jest.mock('simple-git', () => jest.fn(() => mockCwdGitInstance));

describe('GitService', () => {
  let service: GitService;
  let configService: ConfigService;
  let loggerService: LoggerService;
  let mockGit: any;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        GitService,
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn(),
          },
        },
        {
          provide: LoggerService,
          useValue: {
            success: jest.fn(),
            warn: jest.fn(),
            error: jest.fn(),
          },
        },
      ],
    }).compile();

    service = module.get<GitService>(GitService);
    configService = module.get<ConfigService>(ConfigService);
    loggerService = module.get<LoggerService>(LoggerService);

    mockGit = {
      status: jest.fn(),
      push: jest.fn(),
    };
    Object.defineProperty(service, 'git', {
      value: mockGit,
      writable: true,
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('development and main branch detection', () => {
    it('detectDevelopmentBranches returns every branch containing "dev"', () => {
      const devBranches = service.detectDevelopmentBranches(['main', 'develop', 'dev', 'feature/something']);

      expect(devBranches).toEqual(['develop', 'dev']);
    });

    it('detectMainBranch prefers "main"', () => {
      expect(service.detectMainBranch(['develop', 'main', 'feature/x'])).toBe('main');
    });

    it('detectMainBranch falls back to "master" when no "main" exists', () => {
      expect(service.detectMainBranch(['develop', 'master', 'feature/x'])).toBe('master');
    });
  });

  describe('createBranch() name validation', () => {
    const allowExistingBranchCheckout = (branchName: string) => {
      mockGit.status = jest.fn().mockResolvedValue({ current: 'develop' });
      mockGit.branch = jest.fn().mockResolvedValue({ all: [branchName] });
      mockGit.checkout = jest.fn().mockResolvedValue(undefined);
    };

    it('rejects a name containing spaces with a specific reason', async () => {
      await expect(service.createBranch('git checkout -b fix/WBP-4015__reviews-feed')).rejects.toThrow(
        InvalidBranchNameError
      );
      await expect(service.createBranch('git checkout -b fix/WBP-4015__reviews-feed')).rejects.toThrow(
        'Branch names cannot contain spaces'
      );
    });

    it('rejects a shape-invalid name naming every accepted pattern', async () => {
      await expect(service.createBranch('fix/nested/name')).rejects.toThrow(
        'Branch names should follow pattern: feature/name, WBP-1234__feature-name, or simple-name'
      );
    });

    it('accepts a type/KEY__description branch name', async () => {
      allowExistingBranchCheckout('fix/WBP-4015__reviews-feed');

      await service.createBranch('fix/WBP-4015__reviews-feed');

      expect(mockGit.checkout).toHaveBeenCalledWith('fix/WBP-4015__reviews-feed');
    });

    it('trims surrounding whitespace before validating and creating', async () => {
      allowExistingBranchCheckout('fix/WBP-4015__reviews-feed');

      await service.createBranch('  fix/WBP-4015__reviews-feed  ');

      expect(mockGit.checkout).toHaveBeenCalledWith('fix/WBP-4015__reviews-feed');
    });

    it('honors a configured git.branchNamePattern over the built-in patterns', async () => {
      (configService.get as jest.Mock).mockImplementation((key: string) =>
        key === 'git.branchNamePattern' ? '^[A-Za-z]+\\/[\\w-]+$' : undefined
      );
      allowExistingBranchCheckout('Feat/checkout-totals');

      await service.createBranch('Feat/checkout-totals');

      expect(mockGit.checkout).toHaveBeenCalledWith('Feat/checkout-totals');
    });

    it('rejects a name that misses the configured pattern and names that pattern', async () => {
      (configService.get as jest.Mock).mockImplementation((key: string) =>
        key === 'git.branchNamePattern' ? '^team\\/[a-z-]+$' : undefined
      );

      await expect(service.createBranch('fix/checkout-totals')).rejects.toThrow(
        'Branch names should follow pattern: ^team\\/[a-z-]+$'
      );
    });

    it('still enforces git ref conventions when the configured pattern is permissive', async () => {
      (configService.get as jest.Mock).mockImplementation((key: string) =>
        key === 'git.branchNamePattern' ? '.+' : undefined
      );

      await expect(service.createBranch('fix/a..b')).rejects.toThrow('Branch names cannot contain ".."');
    });

    it('honors a --branch-name-pattern override over the configured pattern', async () => {
      (configService.get as jest.Mock).mockImplementation((key: string) =>
        key === 'git.branchNamePattern' ? '^team\\/[a-z-]+$' : undefined
      );
      allowExistingBranchCheckout('fix/checkout-totals');

      await service.createBranch('fix/checkout-totals', { patternOverride: '^[a-z]+\\/[\\w-]+$' });

      expect(mockGit.checkout).toHaveBeenCalledWith('fix/checkout-totals');
    });

    it('rejects a name that misses the override pattern and names that pattern', async () => {
      await expect(
        service.createBranch('fix/checkout-totals', { patternOverride: '^team\\/[a-z-]+$' })
      ).rejects.toThrow('Branch names should follow pattern: ^team\\/[a-z-]+$');
    });

    it('warns and falls back to the configured pattern when the override regex is invalid', async () => {
      (configService.get as jest.Mock).mockImplementation((key: string) =>
        key === 'git.branchNamePattern' ? '^team\\/[a-z-]+$' : undefined
      );
      allowExistingBranchCheckout('team/checkout-totals');

      await service.createBranch('team/checkout-totals', { patternOverride: '[' });

      expect(mockGit.checkout).toHaveBeenCalledWith('team/checkout-totals');
      expect(loggerService.warn).toHaveBeenCalledWith(expect.stringContaining('--branch-name-pattern'));
    });

    it('warns and falls back to built-in patterns when the configured pattern is invalid regex', async () => {
      (configService.get as jest.Mock).mockImplementation((key: string) =>
        key === 'git.branchNamePattern' ? '[' : undefined
      );
      allowExistingBranchCheckout('fix/WBP-4015__reviews-feed');

      await service.createBranch('fix/WBP-4015__reviews-feed');

      expect(mockGit.checkout).toHaveBeenCalledWith('fix/WBP-4015__reviews-feed');
      expect(loggerService.warn).toHaveBeenCalledWith(expect.stringContaining('git.branchNamePattern'));
    });
  });

  describe('push() protected branch guard', () => {
    it('refuses push to main', async () => {
      (configService.get as jest.Mock).mockReturnValue(undefined);
      (mockGit.status as jest.Mock).mockResolvedValue({ current: 'main' });

      await expect(service.push()).rejects.toThrow(GitError);
      await expect(service.push()).rejects.toThrow('Refusing to push directly to protected branch');
    });

    it('refuses push to master', async () => {
      (configService.get as jest.Mock).mockReturnValue(undefined);
      (mockGit.status as jest.Mock).mockResolvedValue({ current: 'master' });

      await expect(service.push()).rejects.toThrow(GitError);
      await expect(service.push()).rejects.toThrow('Refusing to push directly to protected branch');
    });

    it('refuses push to develop', async () => {
      (configService.get as jest.Mock).mockReturnValue(undefined);
      (mockGit.status as jest.Mock).mockResolvedValue({ current: 'develop' });

      await expect(service.push()).rejects.toThrow(GitError);
      await expect(service.push()).rejects.toThrow('Refusing to push directly to protected branch');
    });

    it('strips origin/ prefix before matching', async () => {
      (configService.get as jest.Mock).mockReturnValue(undefined);

      await expect(service.push('origin', 'origin/main')).rejects.toThrow(GitError);
      await expect(service.push('origin', 'origin/main')).rejects.toThrow(
        'Refusing to push directly to protected branch'
      );
    });

    it('strips remotes/origin/ prefix before matching', async () => {
      (configService.get as jest.Mock).mockReturnValue(undefined);

      await expect(service.push('origin', 'remotes/origin/develop')).rejects.toThrow(GitError);
      await expect(service.push('origin', 'remotes/origin/develop')).rejects.toThrow(
        'Refusing to push directly to protected branch'
      );
    });

    it('allows push to feature/foo', async () => {
      (configService.get as jest.Mock).mockReturnValue(undefined);
      (mockGit.push as jest.Mock).mockResolvedValue(undefined);

      await service.push('origin', 'feature/foo');

      expect(mockGit.push).toHaveBeenCalled();
    });

    it('allows branches not in custom protectedBranches config', async () => {
      (configService.get as jest.Mock).mockReturnValue(['main', 'release']);
      (mockGit.push as jest.Mock).mockResolvedValue(undefined);

      await service.push('origin', 'develop');

      expect(mockGit.push).toHaveBeenCalled();
    });

    it('refuses branches in custom protectedBranches config', async () => {
      (configService.get as jest.Mock).mockReturnValue(['main', 'release']);

      await expect(service.push('origin', 'release')).rejects.toThrow(GitError);
      await expect(service.push('origin', 'release')).rejects.toThrow(
        'Refusing to push directly to protected branch'
      );
    });

    it('disables guard when protectedBranches is empty array', async () => {
      (configService.get as jest.Mock).mockReturnValue([]);
      (mockGit.push as jest.Mock).mockResolvedValue(undefined);

      await service.push('origin', 'main');

      expect(mockGit.push).toHaveBeenCalled();
    });

    it('performs case-insensitive branch matching', async () => {
      (configService.get as jest.Mock).mockReturnValue(undefined);

      await expect(service.push('origin', 'Main')).rejects.toThrow(GitError);
      await expect(service.push('origin', 'MASTER')).rejects.toThrow(GitError);
      await expect(service.push('origin', 'Develop')).rejects.toThrow(GitError);
    });
  });

  describe('resetSoftToCommit()', () => {
    beforeEach(() => {
      mockCwdGitInstance.reset.mockReset().mockResolvedValue(undefined);
      mockCwdGitInstance.status.mockReset();
    });

    it('issues reset --soft against the given ref', async () => {
      mockCwdGitInstance.status.mockResolvedValue({ staged: [] });

      await service.resetSoftToCommit('abc123', '/repo');

      expect(mockCwdGitInstance.reset).toHaveBeenCalledWith(['--soft', 'abc123']);
    });

    it('unstages excluded tooling paths while leaving ordinary source paths staged', async () => {
      mockCwdGitInstance.status.mockResolvedValue({
        staged: ['.wf/state/x.json', 'dist/main.js', 'wf.config.ts', 'src/app.ts'],
      });

      await service.resetSoftToCommit('abc123', '/repo');

      expect(mockCwdGitInstance.reset).toHaveBeenNthCalledWith(1, ['--soft', 'abc123']);
      expect(mockCwdGitInstance.reset).toHaveBeenNthCalledWith(2, [
        '--', '.wf/state/x.json', 'dist/main.js', 'wf.config.ts',
      ]);
      expect(mockCwdGitInstance.reset).toHaveBeenCalledTimes(2);
    });

    it('does not issue a second reset when nothing excluded is staged', async () => {
      mockCwdGitInstance.status.mockResolvedValue({ staged: ['src/app.ts'] });

      await service.resetSoftToCommit('abc123', '/repo');

      expect(mockCwdGitInstance.reset).toHaveBeenCalledTimes(1);
    });

    it('wraps a failing reset in a GitError', async () => {
      mockCwdGitInstance.reset.mockReset().mockRejectedValue(new Error('boom'));

      await expect(service.resetSoftToCommit('abc123', '/repo')).rejects.toThrow(GitError);
    });
  });

  describe('stageAll()', () => {
    beforeEach(() => {
      mockCwdGitInstance.status.mockReset();
      mockCwdGitInstance.add.mockReset();
    });

    it('stages every stageable path from status in a single call', async () => {
      mockCwdGitInstance.status.mockResolvedValue({
        files: [
          { path: 'src/app.ts', index: ' ', working_dir: 'M' },
          { path: 'README.md', index: ' ', working_dir: '?' },
        ],
      });
      mockCwdGitInstance.add.mockResolvedValue(undefined);

      await service.stageAll('/repo');

      expect(mockCwdGitInstance.add).toHaveBeenCalledTimes(1);
      expect(mockCwdGitInstance.add).toHaveBeenCalledWith(['src/app.ts', 'README.md']);
    });

    it('does not call add when there is nothing stageable', async () => {
      mockCwdGitInstance.status.mockResolvedValue({ files: [] });

      await service.stageAll('/repo');

      expect(mockCwdGitInstance.add).not.toHaveBeenCalled();
    });

    it('recovers from a vanished pathspec by retrying against a fresh status snapshot', async () => {
      mockCwdGitInstance.status
        .mockResolvedValueOnce({
          files: [
            { path: 'src/app.ts', index: ' ', working_dir: 'M' },
            { path: 'deleted-elsewhere.ts', index: ' ', working_dir: 'M' },
          ],
        })
        .mockResolvedValueOnce({ files: [{ path: 'src/app.ts', index: ' ', working_dir: 'M' }] });
      mockCwdGitInstance.add
        .mockRejectedValueOnce(new Error("fatal: pathspec 'deleted-elsewhere.ts' did not match any files"))
        .mockResolvedValueOnce(undefined);

      await expect(service.stageAll('/repo')).resolves.toBeUndefined();

      expect(mockCwdGitInstance.add).toHaveBeenCalledTimes(2);
      expect(mockCwdGitInstance.add).toHaveBeenNthCalledWith(1, ['src/app.ts', 'deleted-elsewhere.ts']);
      expect(mockCwdGitInstance.add).toHaveBeenNthCalledWith(2, ['src/app.ts']);
      expect(loggerService.warn).toHaveBeenCalledWith(expect.stringContaining('vanished after git status'));
    });

    it('resolves without a second add call when the retry status has nothing left to stage', async () => {
      mockCwdGitInstance.status
        .mockResolvedValueOnce({ files: [{ path: 'deleted-elsewhere.ts', index: ' ', working_dir: 'M' }] })
        .mockResolvedValueOnce({ files: [] });
      mockCwdGitInstance.add.mockRejectedValueOnce(
        new Error("fatal: pathspec 'deleted-elsewhere.ts' did not match any files")
      );

      await expect(service.stageAll('/repo')).resolves.toBeUndefined();

      expect(mockCwdGitInstance.add).toHaveBeenCalledTimes(1);
    });

    it('wraps a non-pathspec add failure as GitError without retrying', async () => {
      mockCwdGitInstance.status.mockResolvedValue({ files: [{ path: 'src/app.ts', index: ' ', working_dir: 'M' }] });
      mockCwdGitInstance.add.mockRejectedValue(new Error('permission denied'));

      await expect(service.stageAll('/repo')).rejects.toThrow(GitError);
      expect(mockCwdGitInstance.status).toHaveBeenCalledTimes(1);
      expect(mockCwdGitInstance.add).toHaveBeenCalledTimes(1);
    });

    it('wraps the error as GitError if the retry itself still fails', async () => {
      mockCwdGitInstance.status.mockResolvedValue({ files: [{ path: 'deleted-elsewhere.ts', index: ' ', working_dir: 'D' }] });
      mockCwdGitInstance.add.mockRejectedValue(
        new Error("fatal: pathspec 'deleted-elsewhere.ts' did not match any files")
      );

      await expect(service.stageAll('/repo')).rejects.toThrow(GitError);
      expect(mockCwdGitInstance.add).toHaveBeenCalledTimes(2);
    });

    it('skips a deletion already fully reflected in the index after a soft reset', async () => {
      mockCwdGitInstance.status.mockResolvedValue({
        files: [
          { path: 'src/app.ts', index: ' ', working_dir: 'M' },
          { path: 'sonar-project.properties', index: 'D', working_dir: ' ' },
        ],
      });
      mockCwdGitInstance.add.mockResolvedValue(undefined);

      await expect(service.stageAll('/repo')).resolves.toBeUndefined();

      expect(mockCwdGitInstance.add).toHaveBeenCalledTimes(1);
      expect(mockCwdGitInstance.add).toHaveBeenCalledWith(['src/app.ts']);
      expect(mockCwdGitInstance.add).not.toHaveBeenCalledWith(
        expect.arrayContaining(['sonar-project.properties'])
      );
      expect(mockCwdGitInstance.status).toHaveBeenCalledTimes(1);
      expect(loggerService.warn).not.toHaveBeenCalled();
    });

    it('does not call add when every status entry is already fully staged', async () => {
      mockCwdGitInstance.status.mockResolvedValue({
        files: [{ path: 'sonar-project.properties', index: 'D', working_dir: ' ' }],
      });

      await expect(service.stageAll('/repo')).resolves.toBeUndefined();

      expect(mockCwdGitInstance.add).not.toHaveBeenCalled();
    });

    it('excludes a rename already fully reflected in the index', async () => {
      mockCwdGitInstance.status.mockResolvedValue({
        files: [{ from: 'old.ts', path: 'new.ts', index: 'R', working_dir: ' ' }],
      });

      await expect(service.stageAll('/repo')).resolves.toBeUndefined();

      expect(mockCwdGitInstance.add).not.toHaveBeenCalled();
    });

    it('stages the rename target path when the rename has a pending working-tree change', async () => {
      mockCwdGitInstance.status.mockResolvedValue({
        files: [{ from: 'old.ts', path: 'new.ts', index: 'R', working_dir: 'M' }],
      });
      mockCwdGitInstance.add.mockResolvedValue(undefined);

      await expect(service.stageAll('/repo')).resolves.toBeUndefined();

      expect(mockCwdGitInstance.add).toHaveBeenCalledWith(['new.ts']);
    });

    it('stages a conflicted file without retrying', async () => {
      // For conflicts, index/working_dir encode the two conflict sides rather than
      // index-vs-worktree, so working_dir !== ' ' correctly keeps conflicted paths included.
      mockCwdGitInstance.status.mockResolvedValue({
        files: [{ path: 'src/conflict.ts', index: 'U', working_dir: 'U' }],
      });
      mockCwdGitInstance.add.mockResolvedValue(undefined);

      await expect(service.stageAll('/repo')).resolves.toBeUndefined();

      expect(mockCwdGitInstance.add).toHaveBeenCalledTimes(1);
      expect(mockCwdGitInstance.add).toHaveBeenCalledWith(['src/conflict.ts']);
    });

    it('selectStageablePaths filters to pending working-tree changes only', () => {
      const status = {
        files: [
          { path: 'src/app.ts', index: ' ', working_dir: 'M' },
          { path: 'sonar-project.properties', index: 'D', working_dir: ' ' },
          { from: 'old.ts', path: 'new.ts', index: 'R', working_dir: ' ' },
          { path: '.wf/state/foo.json', index: '?', working_dir: '?' },
        ],
      } as unknown as StatusResult;

      const result = (service as unknown as { selectStageablePaths(s: StatusResult): string[] })
        .selectStageablePaths(status);

      expect(result).toEqual(['src/app.ts']);
    });
  });

  describe('listCommitsInRange()', () => {
    beforeEach(() => {
      mockCwdGitInstance.raw.mockReset();
    });

    it('returns parsed hash/subject pairs from rev-list output', async () => {
      mockCwdGitInstance.raw.mockResolvedValue('aaa111\0Fix bug\nbbb222\0Add feature\n');

      const commits = await service.listCommitsInRange({ from: 'base', to: 'HEAD' }, '/repo');

      expect(commits).toEqual([
        { hash: 'aaa111', subject: 'Fix bug' },
        { hash: 'bbb222', subject: 'Add feature' },
      ]);
    });

    it('returns an empty array when the range has no commits', async () => {
      mockCwdGitInstance.raw.mockResolvedValue('');

      const commits = await service.listCommitsInRange({ from: 'base', to: 'HEAD' }, '/repo');

      expect(commits).toEqual([]);
    });

    it('passes --merges only when mergesOnly is true', async () => {
      mockCwdGitInstance.raw.mockResolvedValue('');

      await service.listCommitsInRange({ from: 'base', to: 'HEAD', mergesOnly: true }, '/repo');

      expect(mockCwdGitInstance.raw).toHaveBeenCalledWith(expect.arrayContaining(['--merges']));

      mockCwdGitInstance.raw.mockClear();
      await service.listCommitsInRange({ from: 'base', to: 'HEAD' }, '/repo');
      expect(mockCwdGitInstance.raw).toHaveBeenCalledWith(expect.not.arrayContaining(['--merges']));
    });

    it('wraps a failing rev-list call in a GitError', async () => {
      mockCwdGitInstance.raw.mockRejectedValue(new Error('boom'));

      await expect(service.listCommitsInRange({ from: 'base', to: 'HEAD' }, '/repo')).rejects.toThrow(GitError);
    });
  });

  describe('getMergeBase()', () => {
    beforeEach(() => {
      mockCwdGitInstance.raw.mockReset();
    });

    it('returns the trimmed common-ancestor sha', async () => {
      mockCwdGitInstance.raw.mockResolvedValue('44ad52b2cba1142af84c8162d236bc0dd2791132\n');

      const sha = await service.getMergeBase('develop', 'feature/x', '/repo');

      expect(sha).toBe('44ad52b2cba1142af84c8162d236bc0dd2791132');
      expect(mockCwdGitInstance.raw).toHaveBeenCalledWith(['merge-base', 'develop', 'feature/x']);
    });

    it('returns null when the refs share no common ancestor', async () => {
      mockCwdGitInstance.raw.mockRejectedValue(new Error('fatal: no merge base'));

      const sha = await service.getMergeBase('develop', 'feature/x', '/repo');

      expect(sha).toBeNull();
    });
  });

  describe('getUpstreamRef()', () => {
    beforeEach(() => {
      mockCwdGitInstance.raw.mockReset();
    });

    it('returns the trimmed upstream tracking ref', async () => {
      mockCwdGitInstance.raw.mockResolvedValue('origin/develop\n');

      const ref = await service.getUpstreamRef('develop', '/repo');

      expect(ref).toBe('origin/develop');
      expect(mockCwdGitInstance.raw).toHaveBeenCalledWith(['rev-parse', '--abbrev-ref', 'develop@{upstream}']);
    });

    it('returns null when the branch has no upstream configured', async () => {
      mockCwdGitInstance.raw.mockRejectedValue(new Error('fatal: no upstream configured'));

      const ref = await service.getUpstreamRef('develop', '/repo');

      expect(ref).toBeNull();
    });
  });

  describe('getBranchCreationSource()', () => {
    beforeEach(() => {
      mockCwdGitInstance.raw.mockReset();
    });

    it('parses the source branch from a checkout -b reflog entry', async () => {
      mockCwdGitInstance.raw.mockResolvedValue(
        '0e3e24c feature/x@{0}: commit: work\n'
        + '3769e25 feature/x@{1}: branch: Created from develop\n'
      );

      const source = await service.getBranchCreationSource('feature/x', '/repo');

      expect(source).toBe('develop');
      expect(mockCwdGitInstance.raw).toHaveBeenCalledWith(['reflog', 'show', 'feature/x']);
    });

    it('returns null when the reflog entry is the generic "Created from HEAD"', async () => {
      mockCwdGitInstance.raw.mockResolvedValue('3769e25 feature/x@{0}: branch: Created from HEAD\n');

      const source = await service.getBranchCreationSource('feature/x', '/repo');

      expect(source).toBeNull();
    });

    it('returns null when the reflog has no creation entry (e.g. expired or never local)', async () => {
      mockCwdGitInstance.raw.mockResolvedValue('1a2b3c4 feature/x@{0}: clone: from origin\n');

      const source = await service.getBranchCreationSource('feature/x', '/repo');

      expect(source).toBeNull();
    });

    it('returns null when the reflog command fails', async () => {
      mockCwdGitInstance.raw.mockRejectedValue(new Error('fatal: no reflog for feature/x'));

      const source = await service.getBranchCreationSource('feature/x', '/repo');

      expect(source).toBeNull();
    });
  });

  describe('getChangedFilesSince()', () => {
    beforeEach(() => {
      mockCwdGitInstance.raw.mockReset();
    });

    it('lists files changed since the given ref, including uncommitted changes', async () => {
      mockCwdGitInstance.raw.mockResolvedValue('src/a.ts\nsrc/b.ts\n');

      const files = await service.getChangedFilesSince('44ad52b2cba1142af84c8162d236bc0dd2791132', '/repo');

      expect(files).toEqual(['src/a.ts', 'src/b.ts']);
      expect(mockCwdGitInstance.raw).toHaveBeenCalledWith([
        'diff', '--name-only', '44ad52b2cba1142af84c8162d236bc0dd2791132',
      ]);
    });

    it('returns an empty list when there is nothing to diff', async () => {
      mockCwdGitInstance.raw.mockResolvedValue('');

      const files = await service.getChangedFilesSince('develop', '/repo');

      expect(files).toEqual([]);
    });

    it('returns an empty list when the diff command fails', async () => {
      mockCwdGitInstance.raw.mockRejectedValue(new Error('fatal: bad revision'));

      const files = await service.getChangedFilesSince('develop', '/repo');

      expect(files).toEqual([]);
    });
  });

  describe('finaliseCommit capitalization', () => {
    it('capitalizes a lowercase description before calling git.commit', async () => {
      mockCwdGitInstance.status.mockResolvedValue({ staged: ['src/a.ts'], files: [] });
      mockCwdGitInstance.commit.mockResolvedValue({ commit: 'abc123' });

      await service.commit({ message: 'feat: add thing', cwd: '/repo' });

      expect(mockCwdGitInstance.commit).toHaveBeenCalledWith('feat: Add thing');
    });

    it('leaves an already-uppercase description unchanged', async () => {
      mockCwdGitInstance.status.mockResolvedValue({ staged: ['src/a.ts'], files: [] });
      mockCwdGitInstance.commit.mockResolvedValue({ commit: 'abc123' });

      await service.commit({ message: 'feat: Add thing', cwd: '/repo' });

      expect(mockCwdGitInstance.commit).toHaveBeenCalledWith('feat: Add thing');
    });
  });

  describe('createCommitGit configuration', () => {
    it('constructs simple-git with a 90s block timeout for commits', async () => {
      const simpleGitMock = jest.requireMock('simple-git');
      mockCwdGitInstance.status.mockResolvedValue({ staged: ['src/a.ts'], files: [] });
      mockCwdGitInstance.commit.mockResolvedValue({ commit: 'abc123' });

      await service.commit({ message: 'feat: Add thing', cwd: '/repo' });

      expect(simpleGitMock).toHaveBeenCalledWith(
        expect.objectContaining({ timeout: { block: 90_000 } })
      );
    });

    it('sets GIT_TERMINAL_PROMPT=0 and GIT_EDITOR=true in the commit env', async () => {
      mockCwdGitInstance.status.mockResolvedValue({ staged: ['src/a.ts'], files: [] });
      mockCwdGitInstance.commit.mockResolvedValue({ commit: 'abc123' });

      await service.commit({ message: 'feat: Add thing', cwd: '/repo' });

      expect(mockCwdGitInstance.env).toHaveBeenCalledWith(
        expect.objectContaining({ GIT_TERMINAL_PROMPT: '0', GIT_EDITOR: 'true' })
      );
    });

    it('does not set LEFTHOOK in the commit env', async () => {
      mockCwdGitInstance.status.mockResolvedValue({ staged: ['src/a.ts'], files: [] });
      mockCwdGitInstance.commit.mockResolvedValue({ commit: 'abc123' });

      await service.commit({ message: 'feat: Add thing', cwd: '/repo' });

      const envArg = mockCwdGitInstance.env.mock.calls[0]?.[0] ?? {};
      expect(envArg).not.toHaveProperty('LEFTHOOK');
    });
  });
});
