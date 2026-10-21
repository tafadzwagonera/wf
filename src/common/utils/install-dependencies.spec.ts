import { execSync, spawnSync } from 'child_process';
import * as fs from 'node:fs';
import { installDependencies, runDependencyInstallForVerification } from './install-dependencies';
import { detectPackageManager } from './detect-repo-conventions';

jest.mock('child_process', () => ({
  ...jest.requireActual('child_process'),
  exec: jest.fn(),
  execFile: jest.fn(),
  execFileSync: jest.fn(),
  execSync: jest.fn(),
  spawn: jest.fn(),
  spawnSync: jest.fn(),
}));
jest.mock('node:fs', () => ({
  ...jest.requireActual('node:fs'),
  existsSync: jest.fn(),
}));
jest.mock('./detect-repo-conventions');

const mockExecSync = execSync as jest.MockedFunction<typeof execSync>;
const mockSpawnSync = spawnSync as jest.MockedFunction<typeof spawnSync>;
const mockExistsSync = fs.existsSync as jest.MockedFunction<typeof fs.existsSync>;
const mockDetectPackageManager = detectPackageManager as jest.MockedFunction<typeof detectPackageManager>;

const REPO_DIR = '/fake/repo';

describe('installDependencies', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockExistsSync.mockReturnValue(true);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('returns a warning instead of throwing when the package manager is not on PATH', async () => {
    mockDetectPackageManager.mockReturnValue('yarn');
    mockExecSync.mockImplementation(() => {
      throw new Error('command not found');
    });

    const result = await installDependencies(REPO_DIR);

    expect(result.success).toBe(false);
    expect(result).toMatchObject({ packageManager: 'yarn', warning: expect.stringContaining('yarn') });
  });

  it('returns success when the install command exits cleanly', async () => {
    mockDetectPackageManager.mockReturnValue('npm');
    mockExecSync.mockReturnValue(Buffer.from(''));

    const result = await installDependencies(REPO_DIR);

    expect(result).toEqual({ packageManager: 'npm', success: true });
  });

  it('returns a warning instead of throwing when the install command fails', async () => {
    mockDetectPackageManager.mockReturnValue('npm');
    mockExecSync
      .mockReturnValueOnce(Buffer.from(''))
      .mockImplementationOnce(() => {
        throw new Error('lockfile out of date');
      });

    const result = await installDependencies(REPO_DIR);

    expect(result.success).toBe(false);
    expect(result).toMatchObject({
      packageManager: 'npm',
      warning: expect.stringContaining('npm ci'),
    });
  });

  it.each([
    ['bun' as const, 'bun install'],
    ['pnpm' as const, 'pnpm install --frozen-lockfile'],
    ['yarn' as const, 'yarn install --frozen-lockfile'],
    ['npm' as const, 'npm ci'],
  ])('runs %s via "%s"', async (packageManager, expectedCommand) => {
    mockDetectPackageManager.mockReturnValue(packageManager);
    mockExecSync.mockReturnValue(Buffer.from(''));

    await installDependencies(REPO_DIR);

    expect(mockExecSync).toHaveBeenNthCalledWith(2, expectedCommand, expect.objectContaining({ cwd: REPO_DIR }));
  });

  it('passes no timeout to the install execSync call', async () => {
    mockDetectPackageManager.mockReturnValue('npm');
    mockExecSync.mockReturnValue(Buffer.from(''));

    await installDependencies(REPO_DIR);

    const installCallOptions = mockExecSync.mock.calls[1][1];
    expect(installCallOptions).not.toHaveProperty('timeout');
  });

  it('skips the install without invoking a package manager when there is no package.json', async () => {
    mockDetectPackageManager.mockReturnValue('npm');
    mockExistsSync.mockReturnValue(false);

    const result = await installDependencies(REPO_DIR);

    expect(result).toEqual({ packageManager: 'npm', success: true, skipped: true });
    expect(mockExecSync).not.toHaveBeenCalled();
  });
});

describe('runDependencyInstallForVerification', () => {
  const options = { timeoutMs: 1234, maxOutputBytes: 8 };

  beforeEach(() => {
    jest.clearAllMocks();
    mockExistsSync.mockReturnValue(true);
    mockDetectPackageManager.mockReturnValue('yarn');
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('runs yarn with executable arguments and bounded command options', () => {
    mockSpawnSync
      .mockReturnValueOnce({ status: 0, signal: null, stdout: '1.0.0', stderr: '' } as ReturnType<typeof spawnSync>)
      .mockReturnValueOnce({ status: 0, signal: null, stdout: 'installed', stderr: '' } as ReturnType<typeof spawnSync>);

    const result = runDependencyInstallForVerification(REPO_DIR, options);

    expect(result).toMatchObject({ packageManager: 'yarn', result: { status: 'passed' } });
    expect(mockSpawnSync).toHaveBeenNthCalledWith(1, 'yarn', ['--version'], expect.objectContaining({ cwd: REPO_DIR, timeout: 1234, maxBuffer: 8 }));
    expect(mockSpawnSync).toHaveBeenNthCalledWith(2, 'yarn', ['install', '--frozen-lockfile'], expect.objectContaining({ cwd: REPO_DIR }));
  });

  it.each([
    ['bun' as const, ['install']],
    ['pnpm' as const, ['install', '--frozen-lockfile']],
    ['yarn' as const, ['install', '--frozen-lockfile']],
    ['npm' as const, ['ci']],
  ])('uses the expected %s install arguments', (packageManager, expectedArguments) => {
    mockDetectPackageManager.mockReturnValue(packageManager);
    mockSpawnSync.mockReturnValue({ status: 0, signal: null, stdout: '', stderr: '' } as ReturnType<typeof spawnSync>);

    runDependencyInstallForVerification(REPO_DIR, options);

    expect(mockSpawnSync).toHaveBeenNthCalledWith(2, packageManager, expectedArguments, expect.any(Object));
  });

  it('returns not-run without installing when the package manager is unavailable', () => {
    mockSpawnSync.mockReturnValue({ status: null, signal: null, stdout: '', stderr: 'not found', error: new Error('ENOENT') } as ReturnType<typeof spawnSync>);

    const result = runDependencyInstallForVerification(REPO_DIR, options);

    expect(result.result).toMatchObject({ status: 'not-run', reason: 'ENOENT', output: 'not foun' });
    expect(mockSpawnSync).toHaveBeenCalledTimes(1);
  });

  it('reports a timed out installation as not-run', () => {
    mockSpawnSync
      .mockReturnValueOnce({ status: 0, signal: null, stdout: '', stderr: '' } as ReturnType<typeof spawnSync>)
      .mockReturnValueOnce({
        status: null, signal: 'SIGTERM', stdout: '', stderr: '',
        error: Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' }),
      } as unknown as ReturnType<typeof spawnSync>);

    const result = runDependencyInstallForVerification(REPO_DIR, options);

    expect(result.result).toMatchObject({ status: 'not-run', signal: 'SIGTERM', reason: 'Dependency install timed out' });
  });

  it('truncates combined install diagnostics and preserves a nonzero exit code', () => {
    mockSpawnSync
      .mockReturnValueOnce({ status: 0, signal: null, stdout: '', stderr: '' } as ReturnType<typeof spawnSync>)
      .mockReturnValueOnce({ status: 2, signal: null, stdout: 'abcdefgh', stderr: 'ijklmnop' } as ReturnType<typeof spawnSync>);

    const result = runDependencyInstallForVerification(REPO_DIR, options);

    expect(result.result).toMatchObject({ status: 'not-run', exitCode: 2, output: 'abcdefgh', reason: 'Dependency install failed' });
  });

  it('skips the install without spawning a process when there is no package.json', () => {
    mockExistsSync.mockReturnValue(false);

    const result = runDependencyInstallForVerification(REPO_DIR, options);

    expect(result).toMatchObject({
      packageManager: 'yarn',
      result: { command: 'yarn install --frozen-lockfile', status: 'not-run', reason: 'No package.json found; skipping dependency install' },
    });
    expect(mockSpawnSync).not.toHaveBeenCalled();
  });
});
