describe('run-manual-test bootstrap', () => {
  const originalArgv = process.argv;
  const originalLoadedConfig = process.env.WF_MANUAL_TEST_CONFIG_LOADED;
  const originalManualModuleLoaded = process.env.WF_MANUAL_TEST_MODULE_LOADED;

  beforeEach(() => {
    jest.resetModules();
    process.argv = ['node', 'run-manual-test', 'test-issue-review'];
    delete process.env.WF_MANUAL_TEST_CONFIG_LOADED;
    delete process.env.WF_MANUAL_TEST_MODULE_LOADED;
  });

  afterEach(() => {
    process.argv = originalArgv;
    if (originalLoadedConfig === undefined) {
      delete process.env.WF_MANUAL_TEST_CONFIG_LOADED;
    } else {
      process.env.WF_MANUAL_TEST_CONFIG_LOADED = originalLoadedConfig;
    }
    if (originalManualModuleLoaded === undefined) {
      delete process.env.WF_MANUAL_TEST_MODULE_LOADED;
    } else {
      process.env.WF_MANUAL_TEST_MODULE_LOADED = originalManualModuleLoaded;
    }
    jest.restoreAllMocks();
    jest.resetModules();
  });

  it('preloads wf config before requiring the manual test module', async () => {
    const initializeWfConfig = jest.fn().mockResolvedValue(undefined);
    const resolveConfigCwd = jest.fn().mockReturnValue('/Users/tafadzwagonera/Projects/wf');
    const path = require('path');
    const manualTestModulePath = path.join(process.cwd(), 'test', 'manual', 'test-issue-review.ts');

    jest.doMock('fs', () => ({
      existsSync: jest
        .fn()
        .mockImplementation(
          (candidatePath: string) =>
            candidatePath.endsWith('/test/manual/test-issue-review.ts') && !candidatePath.includes('/src/test/manual/')
        ),
    }));
    jest.doMock('../src/config/wf-config-loader', () => ({
      initializeWfConfig: async (...args: unknown[]) => {
        process.env.WF_MANUAL_TEST_CONFIG_LOADED = 'true';
        return initializeWfConfig(...args);
      },
    }));
    jest.doMock('../src/bootstrap/resolve-config-cwd', () => ({
      resolveConfigCwd,
    }));
    jest.doMock(
      manualTestModulePath,
      () => {
        process.env.WF_MANUAL_TEST_MODULE_LOADED
          = process.env.WF_MANUAL_TEST_CONFIG_LOADED === 'true' ? 'after-config' : 'before-config';
        return {};
      },
      { virtual: true }
    );

    await jest.isolateModulesAsync(async () => {
      const manualRunner = require('../run-manual-test');
      await manualRunner.runManualTest();
    });

    expect(resolveConfigCwd).toHaveBeenCalledWith(['test-issue-review']);
    expect(initializeWfConfig).toHaveBeenCalledWith('/Users/tafadzwagonera/Projects/wf');
    expect(process.env.WF_MANUAL_TEST_MODULE_LOADED).toBe('after-config');
  });
});
