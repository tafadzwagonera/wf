describe('main bootstrap', () => {
  const originalArgv = process.argv;

  beforeEach(() => {
    jest.resetModules();
    process.argv = ['node', 'wf', 'issue:review', '--criteria', 'criteria.txt'];
  });

  afterEach(() => {
    process.argv = originalArgv;
    jest.restoreAllMocks();
  });

  it('exits with code 1 when bootstrap rejects during command startup', async () => {
    const exitSpy = jest
      .spyOn(process, 'exit')
      .mockImplementation(((_code?: number) => undefined) as never);
    const consoleErrorSpy = jest
      .spyOn(console, 'error')
      .mockImplementation(() => {});

    jest.doMock('nest-commander', () => ({
      CommandFactory: {
        run: jest
          .fn()
          .mockRejectedValue(
            new Error(
              'Criteria source must be a Markdown file (.md): criteria.txt',
            ),
          ),
      },
    }));
    jest.doMock('./bootstrap/is-help-invocation', () => ({
      isHelpInvocation: jest.fn().mockReturnValue(false),
    }));
    jest.doMock('./bootstrap/resolve-config-cwd', () => ({
      resolveConfigCwd: jest.fn().mockReturnValue(process.cwd()),
    }));
    jest.doMock('./config/wf-config-loader', () => ({
      initializeWfConfig: jest.fn().mockResolvedValue(undefined),
    }));
    jest.doMock('./app.module', () => ({
      AppModule: class AppModule {},
    }));

    await jest.isolateModulesAsync(async () => {
      require('./main');
      await new Promise((resolve) => setImmediate(resolve));
    });

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining(
        'Criteria source must be a Markdown file (.md): criteria.txt',
      ),
    );
  });
});
