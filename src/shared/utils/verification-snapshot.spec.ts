import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createVerificationSnapshot } from './verification-snapshot';
import { createTempDir as createManagedTempDir } from '../testing/temp-dir';

const git = (repoDir: string, args: string[]): string => execFileSync('git', args, {
  cwd: repoDir, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'],
});

describe('createVerificationSnapshot', () => {
  let repoDir: string;

  beforeEach(() => {
    repoDir = createManagedTempDir('verification-snapshot');
    git(repoDir, ['init']);
    git(repoDir, ['config', 'user.email', 'test@example.com']);
    git(repoDir, ['config', 'user.name', 'Test User']);
    fs.writeFileSync(path.join(repoDir, 'example.txt'), 'before\n');
    git(repoDir, ['add', 'example.txt']);
    git(repoDir, ['commit', '-m', 'initial']);
  });

  afterEach(() => {
    fs.rmSync(repoDir, { recursive: true, force: true });
    jest.restoreAllMocks();
  });

  it('applies the supplied diff in a detached worktree without changing the source tree', () => {
    const sourcePath = path.join(repoDir, 'example.txt');
    fs.writeFileSync(sourcePath, 'after\n');
    const diff = git(repoDir, ['diff']);
    fs.writeFileSync(sourcePath, 'before\n');
    const result = createVerificationSnapshot({ repoDir, diff, invocationId: 'invocation-a' });
    expect('worktreePath' in result).toBe(true);
    if (!('worktreePath' in result)) return;
    expect(fs.readFileSync(path.join(result.worktreePath, 'example.txt'), 'utf-8')).toBe('after\n');
    expect(fs.readFileSync(path.join(repoDir, 'example.txt'), 'utf-8')).toBe('before\n');
    expect(fs.existsSync(path.join(result.worktreePath, '.wf-verification-marker.json'))).toBe(true);
    expect(result.cleanup()).toEqual([]);
    expect(fs.existsSync(result.worktreePath)).toBe(false);
  });

  it('returns not-run rather than an unpatched worktree when the diff cannot apply', () => {
    const result = createVerificationSnapshot({ repoDir, diff: 'not a patch', invocationId: 'invocation-b' });
    expect(result).toMatchObject({ status: 'not-run', reason: expect.stringContaining('materialize reviewed diff') });
  });

  it('uses distinct paths for concurrent invocations', () => {
    const sourcePath = path.join(repoDir, 'example.txt');
    fs.writeFileSync(sourcePath, 'after\n');
    const diff = git(repoDir, ['diff']);
    fs.writeFileSync(sourcePath, 'before\n');
    const first = createVerificationSnapshot({ repoDir, diff, invocationId: 'same-invocation' });
    const second = createVerificationSnapshot({ repoDir, diff, invocationId: 'same-invocation' });
    expect('worktreePath' in first && 'worktreePath' in second).toBe(true);
    if (!('worktreePath' in first) || !('worktreePath' in second)) return;
    expect(first.worktreePath).not.toBe(second.worktreePath);
    first.cleanup();
    second.cleanup();
  });
});
