import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

jest.mock('node:child_process', () => ({ execSync: jest.fn() }));
jest.mock('./post-pull-install', () => ({
  runPostPullDependencyInstall: jest.fn().mockResolvedValue(undefined),
}));

import { execSync } from 'node:child_process';
import { runPostPullDependencyInstall } from './post-pull-install';
import {
  runPreReviewVerification,
  cleanStaleVerificationWorktrees,
  getVerificationWorktreePath,
} from './run-pre-review-verification';
import { createTempDir as createManagedTempDir } from '../testing/temp-dir';

const mockExecSync = execSync as jest.MockedFunction<typeof execSync>;
const mockInstall = runPostPullDependencyInstall as jest.MockedFunction<typeof runPostPullDependencyInstall>;

const worktreeDir = (repoDir: string): string => getVerificationWorktreePath(repoDir);

const stubWorktreeLifecycle = (repoDir: string): void => {
  const wtPath = worktreeDir(repoDir);
  mockExecSync.mockImplementation((cmd: string) => {
    if (cmd.includes('worktree add')) {
      fs.mkdirSync(wtPath, { recursive: true });
      return Buffer.from('');
    }
    if (cmd.includes('worktree list')) {
      return '';
    }
    if (cmd.includes('worktree remove')) {
      fs.rmSync(wtPath, { recursive: true, force: true });
      return Buffer.from('');
    }
    if (cmd.includes('worktree prune')) {
      return Buffer.from('');
    }
    return Buffer.from('');
  });
};

const stubWorktreeWithPackageJson = (repoDir: string, scripts: Record<string, string>): void => {
  const wtPath = worktreeDir(repoDir);
  mockExecSync.mockImplementation((cmd: string) => {
    if (cmd.includes('worktree add')) {
      fs.mkdirSync(wtPath, { recursive: true });
      fs.writeFileSync(path.join(wtPath, 'package.json'), JSON.stringify({ scripts }));
      return Buffer.from('');
    }
    if (cmd.includes('worktree list')) {
      return '';
    }
    if (cmd.includes('worktree remove')) {
      fs.rmSync(wtPath, { recursive: true, force: true });
      return Buffer.from('');
    }
    if (cmd.includes('worktree prune')) {
      return Buffer.from('');
    }
    return Buffer.from('');
  });
};

describe('runPreReviewVerification', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = createManagedTempDir('pre-verify');
    mockInstall.mockResolvedValue(undefined);
    mockExecSync.mockReturnValue(Buffer.from(''));
  });

  afterEach(() => {
    const wtPath = worktreeDir(tmpDir);
    fs.rmSync(wtPath, { recursive: true, force: true });
    fs.rmSync(tmpDir, { recursive: true, force: true });
    jest.clearAllMocks();
  });

  it('returns empty string immediately when skipVerification is true', async () => {
    const result = await runPreReviewVerification(tmpDir, { silent: true, skipVerification: true });
    expect(result).toBe('');
    expect(mockExecSync).not.toHaveBeenCalled();
  });

  it('returns empty string when worktree has no package.json', async () => {
    stubWorktreeLifecycle(tmpDir);
    const result = await runPreReviewVerification(tmpDir, { silent: true });
    expect(result).toBe('');
  });

  it('returns empty string when package.json has no standard verification scripts', async () => {
    stubWorktreeWithPackageJson(tmpDir, { build: 'tsc' });
    const result = await runPreReviewVerification(tmpDir, { silent: true });
    expect(result).toBe('');
  });

  it('creates a worktree, runs verification, then removes the worktree', async () => {
    stubWorktreeWithPackageJson(tmpDir, { lint: 'eslint .' });
    const result = await runPreReviewVerification(tmpDir, { silent: true });

    expect(result).toMatch(/^Pre-review verification:/);
    expect(result).toContain('lint');

    const worktreeAddCalls = mockExecSync.mock.calls.filter(
      ([cmd]) => cmd.includes('worktree add')
    );
    const worktreeRemoveCalls = mockExecSync.mock.calls.filter(
      ([cmd]) => cmd.includes('worktree remove')
    );
    expect(worktreeAddCalls).toHaveLength(1);
    expect(worktreeRemoveCalls).toHaveLength(1);
  });

  it('runs verification commands inside the worktree, not the original repoDir', async () => {
    const wtPath = worktreeDir(tmpDir);
    stubWorktreeWithPackageJson(tmpDir, { lint: 'eslint .' });

    await runPreReviewVerification(tmpDir, { silent: true });

    const verifyCalls = mockExecSync.mock.calls.filter(
      ([cmd]) => cmd.includes('run lint')
    );
    expect(verifyCalls).toHaveLength(1);
    const [, opts] = verifyCalls[0] as [string, { cwd?: string }];
    expect(opts.cwd).toBe(wtPath);
  });

  it('symlinks node_modules from repoDir into the worktree when it exists', async () => {
    fs.mkdirSync(path.join(tmpDir, 'node_modules'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'node_modules', 'marker.txt'), 'present');

    const wtPath = worktreeDir(tmpDir);
    let capturedTarget: string | null = null;
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd.includes('worktree add')) {
        fs.mkdirSync(wtPath, { recursive: true });
        fs.writeFileSync(path.join(wtPath, 'package.json'), JSON.stringify({ scripts: { lint: 'eslint .' } }));
        return Buffer.from('');
      }
      if (cmd.includes('worktree list')) return '';
      if (cmd.includes('worktree remove')) {
        const linked = path.join(wtPath, 'node_modules');
        if (fs.lstatSync(linked).isSymbolicLink()) capturedTarget = fs.realpathSync(linked);
        fs.rmSync(wtPath, { recursive: true, force: true });
        return Buffer.from('');
      }
      if (cmd.includes('worktree prune')) return Buffer.from('');
      return Buffer.from('');
    });

    await runPreReviewVerification(tmpDir, { silent: true });

    expect(capturedTarget).toBe(fs.realpathSync(path.join(tmpDir, 'node_modules')));
  });

  it('does not attempt a symlink when repoDir has no node_modules', async () => {
    stubWorktreeWithPackageJson(tmpDir, { lint: 'eslint .' });
    const wtPath = worktreeDir(tmpDir);

    await expect(runPreReviewVerification(tmpDir, { silent: true })).resolves.not.toThrow();
    expect(fs.existsSync(path.join(wtPath, 'node_modules'))).toBe(false);
  });

  it('marks a failed command with ✗', async () => {
    const wtPath = worktreeDir(tmpDir);
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd.includes('worktree add')) {
        fs.mkdirSync(wtPath, { recursive: true });
        fs.writeFileSync(path.join(wtPath, 'package.json'), JSON.stringify({ scripts: { lint: 'eslint .' } }));
        return Buffer.from('');
      }
      if (cmd.includes('worktree list')) return '';
      if (cmd.includes('worktree remove')) {
        fs.rmSync(wtPath, { recursive: true, force: true });
        return Buffer.from('');
      }
      if (cmd.includes('worktree prune')) return Buffer.from('');
      throw new Error('command failed');
    });

    const result = await runPreReviewVerification(tmpDir, { silent: true });

    expect(result).toContain('✗');
    expect(result).not.toContain('✓');
  });

  it('marks a passing command with ✓', async () => {
    stubWorktreeWithPackageJson(tmpDir, { lint: 'eslint .' });
    const result = await runPreReviewVerification(tmpDir, { silent: true });

    expect(result).toContain('✓');
    expect(result).not.toContain('✗');
  });

  it('calls runPostPullDependencyInstall with the worktree path', async () => {
    const wtPath = worktreeDir(tmpDir);
    stubWorktreeWithPackageJson(tmpDir, { lint: 'eslint .' });

    await runPreReviewVerification(tmpDir, { silent: true });

    expect(mockInstall).toHaveBeenCalledWith(wtPath);
  });

  it('only runs lint, typecheck, and test scripts — ignores other scripts', async () => {
    stubWorktreeWithPackageJson(tmpDir, { build: 'tsc', start: 'node .', lint: 'eslint .' });

    await runPreReviewVerification(tmpDir, { silent: true });

    const verifyCalls = mockExecSync.mock.calls.filter(
      ([cmd]) => cmd.includes(' run ')
    );
    expect(verifyCalls).toHaveLength(1);
    expect(verifyCalls[0][0]).toContain('lint');
  });

  it('removes the worktree even when verification throws', async () => {
    const wtPath = worktreeDir(tmpDir);
    mockInstall.mockRejectedValue(new Error('install boom'));
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd.includes('worktree add')) {
        fs.mkdirSync(wtPath, { recursive: true });
        return Buffer.from('');
      }
      if (cmd.includes('worktree list')) return '';
      if (cmd.includes('worktree remove')) {
        fs.rmSync(wtPath, { recursive: true, force: true });
        return Buffer.from('');
      }
      if (cmd.includes('worktree prune')) return Buffer.from('');
      return Buffer.from('');
    });

    await expect(runPreReviewVerification(tmpDir, { silent: true })).rejects.toThrow('install boom');

    const removeCalls = mockExecSync.mock.calls.filter(
      ([cmd]) => cmd.includes('worktree remove')
    );
    expect(removeCalls).toHaveLength(1);
  });

  it('returns empty string gracefully when worktree creation fails', async () => {
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd.includes('worktree list')) return '';
      if (cmd.includes('worktree add')) throw new Error('worktree add failed');
      return Buffer.from('');
    });

    const result = await runPreReviewVerification(tmpDir, { silent: true });
    expect(result).toBe('');
  });
});

describe('cleanStaleVerificationWorktrees', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = createManagedTempDir('stale-wt');
    mockExecSync.mockReturnValue(Buffer.from(''));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    jest.clearAllMocks();
  });

  it('removes a worktree whose owning pid is no longer running', () => {
    const deadPid = 999999;
    const stalePath = path.join(os.tmpdir(), `wf-verify-abc123-${deadPid}`);
    mockExecSync.mockImplementation(((cmd: string) => {
      if (cmd.includes('worktree list')) return `worktree /main\nworktree ${stalePath}\n`;
      return '';
    }) as typeof execSync);

    cleanStaleVerificationWorktrees(tmpDir);

    const removeCalls = mockExecSync.mock.calls.filter(
      ([cmd]) => cmd.includes('worktree remove')
    );
    expect(removeCalls).toHaveLength(1);
    expect(removeCalls[0][0]).toContain(stalePath);
  });

  it('does not remove a worktree whose owning pid is still running', () => {
    const livePath = path.join(os.tmpdir(), `wf-verify-abc123-${process.pid}`);
    fs.mkdirSync(livePath, { recursive: true });
    mockExecSync.mockImplementation(((cmd: string) => {
      if (cmd.includes('worktree list')) return `worktree /main\nworktree ${livePath}\n`;
      return '';
    }) as typeof execSync);

    try {
      cleanStaleVerificationWorktrees(tmpDir);

      const removeCalls = mockExecSync.mock.calls.filter(
        ([cmd]) => cmd.includes('worktree remove')
      );
      expect(removeCalls).toHaveLength(0);
    } finally {
      fs.rmSync(livePath, { recursive: true, force: true });
    }
  });

  it('removes a worktree with a malformed name lacking a pid suffix', () => {
    const stalePath = path.join(os.tmpdir(), 'wf-verify-abc123');
    mockExecSync.mockImplementation(((cmd: string) => {
      if (cmd.includes('worktree list')) return `worktree /main\nworktree ${stalePath}\n`;
      return '';
    }) as typeof execSync);

    cleanStaleVerificationWorktrees(tmpDir);

    const removeCalls = mockExecSync.mock.calls.filter(
      ([cmd]) => cmd.includes('worktree remove')
    );
    expect(removeCalls).toHaveLength(1);
    expect(removeCalls[0][0]).toContain(stalePath);
  });

  it('does not remove worktrees that do not match the prefix', () => {
    mockExecSync.mockImplementation(((cmd: string) => {
      if (cmd.includes('worktree list')) return 'worktree /main\nworktree /some/other/worktree\n';
      return '';
    }) as typeof execSync);

    cleanStaleVerificationWorktrees(tmpDir);

    const removeCalls = mockExecSync.mock.calls.filter(
      ([cmd]) => cmd.includes('worktree remove')
    );
    expect(removeCalls).toHaveLength(0);
  });

  it('does nothing when git worktree list fails', () => {
    mockExecSync.mockImplementation(((cmd: string) => {
      if (cmd.includes('worktree list')) throw new Error('not a git repo');
      return '';
    }) as typeof execSync);

    expect(() => cleanStaleVerificationWorktrees(tmpDir)).not.toThrow();
  });
});
