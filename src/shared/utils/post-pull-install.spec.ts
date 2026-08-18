import { execSync } from 'child_process';
import { runPostPullDependencyInstall } from './post-pull-install';
import { installDependencies } from './install-dependencies';

jest.mock('child_process', () => ({
  ...jest.requireActual('child_process'),
  exec: jest.fn(),
  execFile: jest.fn(),
  execFileSync: jest.fn(),
  execSync: jest.fn(),
  spawn: jest.fn(),
  spawnSync: jest.fn(),
}));
jest.mock('./install-dependencies');

const mockExecSync = jest.mocked(execSync);
const mockInstallDependencies = jest.mocked(installDependencies);

describe('runPostPullDependencyInstall', () => {
  let consoleSpy: jest.SpiedFunction<typeof console.log>;

  beforeEach(() => {
    consoleSpy = jest.spyOn(console, 'log').mockImplementation();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('does not install when git diff throws', async () => {
    mockExecSync.mockImplementation(() => {
      throw new Error('not a git repo');
    });

    await runPostPullDependencyInstall('/repo');

    expect(mockInstallDependencies).not.toHaveBeenCalled();
  });

  it('does not install when package.json is absent from the diff', async () => {
    mockExecSync.mockReturnValue('src/index.ts\nsrc/utils.ts\n');

    await runPostPullDependencyInstall('/repo');

    expect(mockInstallDependencies).not.toHaveBeenCalled();
  });

  it('does not install for a nested package.json path', async () => {
    mockExecSync.mockReturnValue('apps/web/package.json\n');

    await runPostPullDependencyInstall('/repo');

    expect(mockInstallDependencies).not.toHaveBeenCalled();
  });

  it('installs and logs success when the root package.json changed', async () => {
    mockExecSync.mockReturnValue('src/index.ts\npackage.json\n');
    mockInstallDependencies.mockResolvedValue({ packageManager: 'npm', success: true });

    await runPostPullDependencyInstall('/repo');

    expect(mockInstallDependencies).toHaveBeenCalledWith('/repo');
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Dependencies updated via npm'));
  });

  it('logs a warning and resolves when the install fails', async () => {
    mockExecSync.mockReturnValue('package.json\n');
    mockInstallDependencies.mockResolvedValue({
      packageManager: 'yarn', success: false, warning: 'yarn not found',
    });

    await expect(runPostPullDependencyInstall('/repo')).resolves.toBeUndefined();

    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('yarn not found'));
  });

  it('logs the installing-dependencies message before installing', async () => {
    mockExecSync.mockReturnValue('package.json\n');
    mockInstallDependencies.mockResolvedValue({ packageManager: 'npm', success: true });

    await runPostPullDependencyInstall('/repo');

    expect(consoleSpy.mock.calls[0][0]).toContain('package.json changed');
  });
});
