import { restoreEnv, withEnv } from './common/testing/env';

describe('run-manual-test bootstrap', () => {
  const originalArgv = process.argv;

  beforeEach(() => {
    jest.resetModules();
    process.argv = ['node', 'run-manual-test', 'test-issue-review'];
    withEnv({ WF_MANUAL_TEST_CONFIG_LOADED: undefined, WF_MANUAL_TEST_MODULE_LOADED: undefined });
  });

  afterEach(() => {
    process.argv = originalArgv;
    restoreEnv();
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
            (candidatePath.endsWith('/test/manual/test-issue-review.ts') && !candidatePath.includes('/src/test/manual/'))
            || candidatePath.endsWith('/package.json')
        ),
      readFileSync: jest.fn().mockImplementation((filePath: string) => {
        if (filePath.endsWith('/package.json')) {
          return JSON.stringify({ name: 'wf' });
        }
        throw new Error(`readFileSync called with unexpected path: ${filePath}`);
      }),
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

  it('throws ExecutionError when package.json name is not wf', async () => {
    const mockConsoleError = jest.spyOn(console, 'error').mockImplementation();
    const mockProcessExit = jest.spyOn(process, 'exit').mockImplementation();

    jest.doMock('fs', () => ({
      existsSync: jest.fn().mockReturnValue(true),
      readFileSync: jest.fn().mockReturnValue(JSON.stringify({ name: 'other-project' })),
    }));

    await jest.isolateModulesAsync(async () => {
      require('../run-manual-test');
      await new Promise(resolve => setImmediate(resolve));
    });

    expect(mockConsoleError).toHaveBeenCalledWith(
      expect.stringMatching(/Manual tests must be run from the wf project root/),
    );
    expect(mockProcessExit).toHaveBeenCalledWith(1);
  });

  it('throws ExecutionError when package.json does not exist', async () => {
    const mockConsoleError = jest.spyOn(console, 'error').mockImplementation();
    const mockProcessExit = jest.spyOn(process, 'exit').mockImplementation();

    jest.doMock('fs', () => ({
      existsSync: jest.fn().mockReturnValue(false),
      readFileSync: jest.fn(),
    }));

    await jest.isolateModulesAsync(async () => {
      require('../run-manual-test');
      await new Promise(resolve => setImmediate(resolve));
    });

    expect(mockConsoleError).toHaveBeenCalledWith(
      expect.stringMatching(/Manual tests must be run from the wf project root/),
    );
    expect(mockProcessExit).toHaveBeenCalledWith(1);
  });
});
