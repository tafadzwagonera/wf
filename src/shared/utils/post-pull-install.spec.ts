import { runPostPullDependencyInstall } from './post-pull-install';
import { installDependencies } from './install-dependencies';

jest.mock('./install-dependencies');

const mockInstallDependencies = jest.mocked(installDependencies);

describe('runPostPullDependencyInstall', () => {
  let consoleSpy: jest.SpiedFunction<typeof console.log>;

  beforeEach(() => {
    consoleSpy = jest.spyOn(console, 'log').mockImplementation();
    mockInstallDependencies.mockResolvedValue({ packageManager: 'npm', success: true });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('does not call installDependencies when skip is true', async () => {
    await runPostPullDependencyInstall('/repo', true);
    expect(mockInstallDependencies).not.toHaveBeenCalled();
  });

  it('calls installDependencies when skip is false', async () => {
    await runPostPullDependencyInstall('/repo', false);
    expect(mockInstallDependencies).toHaveBeenCalledWith('/repo');
  });

  it('calls installDependencies when skip is omitted', async () => {
    await runPostPullDependencyInstall('/repo');
    expect(mockInstallDependencies).toHaveBeenCalledWith('/repo');
  });

  it('logs success when installDependencies succeeds', async () => {
    mockInstallDependencies.mockResolvedValue({ packageManager: 'yarn', success: true });
    await runPostPullDependencyInstall('/repo');
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Dependencies updated via yarn'));
  });

  it('logs a warning and resolves when installDependencies fails', async () => {
    mockInstallDependencies.mockResolvedValue({ packageManager: 'npm', success: false, warning: 'npm not found' });
    await expect(runPostPullDependencyInstall('/repo')).resolves.toBeUndefined();
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('npm not found'));
  });
});
