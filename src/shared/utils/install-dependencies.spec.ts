import { execSync } from 'child_process';
import { installDependencies } from './install-dependencies';
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
jest.mock('./detect-repo-conventions');

const mockExecSync = execSync as jest.MockedFunction<typeof execSync>;
const mockDetectPackageManager = detectPackageManager as jest.MockedFunction<typeof detectPackageManager>;

const REPO_DIR = '/fake/repo';

describe('installDependencies', () => {
  afterEach(() => {
    jest.resetAllMocks();
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
});
