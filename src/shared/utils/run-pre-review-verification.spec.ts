import * as fs from 'node:fs';
import { spawnSync } from 'node:child_process';

jest.mock('node:child_process', () => ({ spawnSync: jest.fn() }));
jest.mock('./verification-snapshot', () => ({
  cleanStaleVerificationWorktrees: jest.fn(),
  createVerificationSnapshot: jest.fn(),
}));
jest.mock('./install-dependencies', () => ({ runDependencyInstallForVerification: jest.fn() }));
jest.mock('../logger/log-file-writer', () => ({ appendToLogFile: jest.fn() }));

import { runPreReviewVerification } from './run-pre-review-verification';
import { createVerificationSnapshot } from './verification-snapshot';
import { runDependencyInstallForVerification } from './install-dependencies';
import { appendToLogFile } from '../logger/log-file-writer';
import { createTempDir as createManagedTempDir } from '../testing/temp-dir';

const mockSpawnSync = spawnSync as jest.MockedFunction<typeof spawnSync>;
const mockSnapshot = createVerificationSnapshot as jest.MockedFunction<typeof createVerificationSnapshot>;
const mockInstall
  = runDependencyInstallForVerification as jest.MockedFunction<typeof runDependencyInstallForVerification>;
const mockAppendToLogFile = appendToLogFile as jest.MockedFunction<typeof appendToLogFile>;

describe('runPreReviewVerification', () => {
  let repoDir: string;
  let worktreePath: string;
  let cleanup: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    repoDir = createManagedTempDir('pre-review-verification');
    worktreePath = createManagedTempDir('pre-review-worktree');
    cleanup = jest.fn().mockReturnValue([]);
    fs.writeFileSync(`${worktreePath}/package.json`, JSON.stringify({ scripts: { lint: 'eslint .' } }));
    mockSnapshot.mockReturnValue({ worktreePath, repositoryHead: 'abc123', cleanup });
    mockInstall.mockReturnValue({ packageManager: 'yarn', result: {
      command: 'yarn install --frozen-lockfile', status: 'passed', durationMs: 4,
    } });
    mockSpawnSync.mockReturnValue({ status: 0, signal: null, stdout: '', stderr: '' } as ReturnType<typeof spawnSync>);
  });

  afterEach(() => {
    fs.rmSync(repoDir, { recursive: true, force: true });
    fs.rmSync(worktreePath, { recursive: true, force: true });
    jest.restoreAllMocks();
  });

  it('returns not-run without creating a snapshot when skipped', async () => {
    const result = await runPreReviewVerification(repoDir, { diff: 'diff', skipVerification: true });
    expect(result).toMatchObject({ status: 'not-run', reason: expect.stringContaining('--skip-verification') });
    expect(mockSnapshot).not.toHaveBeenCalled();
  });

  it('returns snapshot materialization failures as not-run', async () => {
    mockSnapshot.mockReturnValue({ status: 'not-run', reason: 'patch rejected' });
    const result = await runPreReviewVerification(repoDir, { diff: 'diff' });
    expect(result).toMatchObject({ status: 'not-run', reason: 'patch rejected' });
    expect(mockInstall).not.toHaveBeenCalled();
  });

  it('stops checks when dependency installation cannot run', async () => {
    mockInstall.mockReturnValue({ packageManager: 'yarn', result: {
      command: 'yarn install --frozen-lockfile', status: 'not-run', durationMs: 3, reason: 'yarn missing',
    } });
    const result = await runPreReviewVerification(repoDir, { diff: 'diff' });
    expect(result.status).toBe('not-run');
    expect(mockSpawnSync).not.toHaveBeenCalled();
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it('runs allowlisted checks in order and returns passed', async () => {
    fs.writeFileSync(`${worktreePath}/package.json`, JSON.stringify({ scripts: { lint: 'eslint .', typecheck: 'tsc', test: 'jest', build: 'nest build' } }));
    const result = await runPreReviewVerification(repoDir, { diff: 'reviewed diff' });
    expect(result.status).toBe('passed');
    expect(result.checks.map(check => check.command)).toEqual(['yarn run lint', 'yarn run typecheck', 'yarn run test']);
    expect(mockSpawnSync).toHaveBeenNthCalledWith(1, 'yarn', ['run', 'lint'], expect.objectContaining({ cwd: worktreePath, timeout: expect.any(Number) }));
  });

  it('returns failed and short-circuits after a failed check', async () => {
    fs.writeFileSync(`${worktreePath}/package.json`, JSON.stringify({ scripts: { lint: 'eslint .', typecheck: 'tsc' } }));
    mockSpawnSync.mockReturnValue({ status: 2, signal: null, stdout: '', stderr: 'lint error' } as ReturnType<typeof spawnSync>);
    const result = await runPreReviewVerification(repoDir, { diff: 'diff' });
    expect(result.status).toBe('failed');
    expect(result.checks).toHaveLength(1);
    expect(result.checks[0]).toMatchObject({ status: 'failed', exitCode: 2, output: 'lint error' });
  });

  it('logs each completed check and cleanup failures without replacing the primary result', async () => {
    cleanup.mockReturnValue(['unable to prune']);
    mockSpawnSync.mockReturnValue({ status: 1, signal: null, stdout: '', stderr: 'bad' } as ReturnType<typeof spawnSync>);
    const result = await runPreReviewVerification(repoDir, { diff: 'diff' });
    expect(result.status).toBe('failed');
    expect(mockAppendToLogFile).toHaveBeenCalledWith('INFO', expect.stringContaining('review-verification.check-completed'), 'review-verification');
    expect(mockAppendToLogFile).toHaveBeenCalledWith('INFO', expect.stringContaining('review-verification.cleanup-failed'), 'review-verification');
  });
});
