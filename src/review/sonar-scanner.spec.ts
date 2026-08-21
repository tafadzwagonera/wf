import * as childProcess from 'node:child_process';
import {
  runSonarScan,
  type SonarScanScope,
  type SonarStepOutcome,
  type SonarScanResult,
} from './sonar-scanner';
import { ConfigurationError, ExecutionError } from '../shared/errors/app.error';

type ExecFileCallback = (err: Error | null, stdout: string, stderr: string) => void;

jest.mock('node:child_process', () => ({
  ...jest.requireActual('node:child_process'),
  exec: jest.fn(),
  execFile: jest.fn(),
  execFileSync: jest.fn(),
  execSync: jest.fn(),
  spawn: jest.fn(),
  spawnSync: jest.fn(),
}));

const mockExecSync = childProcess.execSync as jest.MockedFunction<typeof childProcess.execSync>;
const mockExecFile = childProcess.execFile as jest.MockedFunction<typeof childProcess.execFile>;

beforeEach(() => {
  jest.clearAllMocks();
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('runSonarScan', () => {
  const defaultOptions = {
    repoDir: '/tmp/repo',
    scope: { kind: 'staged' as const },
  };

  describe('preflight check', () => {
    it('throws ConfigurationError when sonar CLI is not available', async () => {
      mockExecSync.mockImplementation(() => {
        throw new Error('command not found');
      });

      await expect(runSonarScan(defaultOptions)).rejects.toThrow(ConfigurationError);
      await expect(runSonarScan(defaultOptions)).rejects.toThrow(/brew install sonarqube-cli/i);
    });
  });

  describe('execution ordering', () => {
    it('runs secrets step before analyze step', async () => {
      mockExecSync.mockReturnValue('');
      mockExecFile.mockImplementation((_cmd, _args, _opts, callback) => {
        const fn = callback as ExecFileCallback;
        fn(null, '', '');
        return {} as any;
      });

      await runSonarScan({ ...defaultOptions, secretPaths: ['secret.ts'] });

      expect(mockExecFile).toHaveBeenCalledTimes(2);
      expect(mockExecFile.mock.calls[0]?.[1]?.[0]).toBe('analyze');
      expect(mockExecFile.mock.calls[0]?.[1]?.[1]).toBe('secrets');
      expect(mockExecFile.mock.calls[1]?.[1]?.[0]).toBe('analyze');
      expect(mockExecFile.mock.calls[1]?.[1]?.[1]).not.toBe('secrets');
    });
  });

  describe('secretPaths handling', () => {
    it('skips secrets step when secretPaths is empty', async () => {
      mockExecSync.mockReturnValue('');
      mockExecFile.mockImplementation((_cmd, _args, _opts, callback) => {
        const fn = callback as ExecFileCallback;
        fn(null, '', '');
        return {} as any;
      });

      const result = await runSonarScan({ ...defaultOptions, secretPaths: [] });

      expect(mockExecFile).toHaveBeenCalledTimes(1);
      expect(result.steps[0]).toEqual(
        expect.objectContaining({ step: 'secrets', status: 'skipped', exitCode: null })
      );
    });

    it('skips secrets step when secretPaths is omitted', async () => {
      mockExecSync.mockReturnValue('');
      mockExecFile.mockImplementation((_cmd, _args, _opts, callback) => {
        const fn = callback as ExecFileCallback;
        fn(null, '', '');
        return {} as any;
      });

      const result = await runSonarScan(defaultOptions);

      expect(mockExecFile).toHaveBeenCalledTimes(1);
      expect(result.steps[0]).toEqual(
        expect.objectContaining({ step: 'secrets', status: 'skipped', exitCode: null })
      );
    });

    it('does not pass repoDir to secrets analyzer', async () => {
      mockExecSync.mockReturnValue('');
      mockExecFile.mockImplementation((_cmd, args, _opts, callback) => {
        const fn = callback as ExecFileCallback;
        if (mockExecFile.mock.calls.length === 1) {
          expect(args).not.toContain('/tmp/repo');
        }
        fn(null, '', '');
        return {} as any;
      });

      await runSonarScan({ ...defaultOptions, secretPaths: ['a.ts', 'b.ts'] });

      const secretsCall = mockExecFile.mock.calls[0];
      expect(secretsCall[1]).not.toContain('/tmp/repo');
    });
  });

  describe('analyze argv construction', () => {
    it('always includes --force, --format text, and --depth STANDARD by default', async () => {
      mockExecSync.mockReturnValue('');
      mockExecFile.mockImplementation((_cmd, _args, _opts, callback) => {
        const fn = callback as ExecFileCallback;
        fn(null, '', '');
        return {} as any;
      });

      await runSonarScan(defaultOptions);

      // Only one execFile call (analyze) since secretPaths is omitted
      const analyzeCall = mockExecFile.mock.calls[0];
      expect(analyzeCall[1]).toContain('--force');
      expect(analyzeCall[1]).toContain('--format');
      expect(analyzeCall[1]).toContain('text');
      expect(analyzeCall[1]).toContain('--depth');
      expect(analyzeCall[1]).toContain('STANDARD');
    });

    it('uses --depth DEEP when specified', async () => {
      mockExecSync.mockReturnValue('');
      mockExecFile.mockImplementation((_cmd, _args, _opts, callback) => {
        const fn = callback as ExecFileCallback;
        fn(null, '', '');
        return {} as any;
      });

      await runSonarScan({ ...defaultOptions, depth: 'DEEP', secretPaths: ['file.ts'] });

      // First call is secrets, second is analyze
      const analyzeCall = mockExecFile.mock.calls[1];
      expect(analyzeCall[1]).toContain('DEEP');
      expect(analyzeCall[1]).not.toContain('STANDARD');
    });

    it('never passes -p flag', async () => {
      mockExecSync.mockReturnValue('');
      mockExecFile.mockImplementation((_cmd, _args, _opts, callback) => {
        const fn = callback as ExecFileCallback;
        fn(null, '', '');
        return {} as any;
      });

      await runSonarScan(defaultOptions);

      for (const call of mockExecFile.mock.calls) {
        expect(call[1]).not.toContain('-p');
      }
    });
  });

  describe('scope variants', () => {
    it('includes --staged for staged scope', async () => {
      mockExecSync.mockReturnValue('');
      mockExecFile.mockImplementation((_cmd, _args, _opts, callback) => {
        const fn = callback as ExecFileCallback;
        fn(null, '', '');
        return {} as any;
      });

      await runSonarScan({ ...defaultOptions, scope: { kind: 'staged' } });

      // Only one execFile call (analyze) since secretPaths is omitted
      const analyzeCall = mockExecFile.mock.calls[0];
      expect(analyzeCall[1]).toContain('--staged');
    });

    it('includes --base and ref for base scope', async () => {
      mockExecSync.mockReturnValue('');
      mockExecFile.mockImplementation((_cmd, _args, _opts, callback) => {
        const fn = callback as ExecFileCallback;
        fn(null, '', '');
        return {} as any;
      });

      await runSonarScan({
        ...defaultOptions,
        scope: { kind: 'base', ref: 'origin/main' },
        secretPaths: ['file.ts'],
      });

      // First call is secrets, second is analyze
      const analyzeCall = mockExecFile.mock.calls[1];
      const baseIndex = analyzeCall?.[1]?.indexOf('--base') ?? -1;
      expect(baseIndex).toBeGreaterThanOrEqual(0);
      expect(analyzeCall?.[1]?.[baseIndex + 1]).toBe('origin/main');
    });

    it('includes repeated --file for each path in files scope', async () => {
      mockExecSync.mockReturnValue('');
      mockExecFile.mockImplementation((_cmd, _args, _opts, callback) => {
        const fn = callback as ExecFileCallback;
        fn(null, '', '');
        return {} as any;
      });

      await runSonarScan({
        ...defaultOptions,
        scope: { kind: 'files', paths: ['a.ts', 'b.ts'] },
        secretPaths: ['secret.ts'],
      });

      // First call is secrets, second is analyze
      const analyzeCall = mockExecFile.mock.calls[1];
      expect(analyzeCall[1]).toContain('--file');
      expect(analyzeCall[1]).toContain('a.ts');
      expect(analyzeCall[1]).toContain('b.ts');
    });

    it('skips analyze when files scope has empty paths', async () => {
      mockExecSync.mockReturnValue('');
      mockExecFile.mockImplementation((_cmd, _args, _opts, callback) => {
        const fn = callback as ExecFileCallback;
        fn(null, '', '');
        return {} as any;
      });

      const result = await runSonarScan({
        ...defaultOptions,
        scope: { kind: 'files', paths: [] },
      });

      // Both secrets (skipped) and analyze (skipped) don't call execFile
      expect(mockExecFile).toHaveBeenCalledTimes(0);
      expect(result.steps[1]).toEqual(
        expect.objectContaining({ step: 'analyze', status: 'skipped', exitCode: null })
      );
    });
  });

  describe('exit code classification', () => {
    it('returns status clean for exit code 0', async () => {
      mockExecSync.mockReturnValue('');
      mockExecFile.mockImplementation((_cmd, _args, _opts, callback) => {
        const fn = callback as ExecFileCallback;
        fn(null, '', '');
        return {} as any;
      });

      const result = await runSonarScan(defaultOptions);

      expect(result.status).toBe('clean');
      expect(result.steps).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ status: 'clean' }),
        ])
      );
    });

    it('returns status findings for exit code 51 and calls onProgress', async () => {
      mockExecSync.mockReturnValue('');
      const mockOnProgress = jest.fn();

      // Simulate analyze step returning 51 (findings)
      // Since secretPaths is omitted, secrets step is skipped (no execFile call)
      // So the first execFile call is the analyze step
      mockExecFile.mockImplementation((_cmd, _args, _opts, callback) => {
        const fn = callback as ExecFileCallback;
        // Analyze step - return 51
        const err = Object.assign(new Error(), { code: 51 });
        fn(err, '', '');
        return {} as any;
      });

      const result = await runSonarScan({ ...defaultOptions, onProgress: mockOnProgress });

      expect(result.status).toBe('findings');
      expect(mockOnProgress).toHaveBeenCalledWith(expect.stringMatching(/finding/i));
    });

    it('throws ConfigurationError for exit code 1 with auth error', async () => {
      mockExecSync.mockReturnValue('');
      mockExecFile.mockImplementation((_cmd, _args, _opts, callback) => {
        const fn = callback as ExecFileCallback;
        const err = Object.assign(new Error(), { code: 1 });
        fn(err, '', 'Not authenticated');
        return {} as any;
      });

      await expect(runSonarScan(defaultOptions)).rejects.toThrow(ConfigurationError);
    });

    it('throws ExecutionError for exit code 1 with unrelated error', async () => {
      mockExecSync.mockReturnValue('');
      mockExecFile.mockImplementation((_cmd, _args, _opts, callback) => {
        const fn = callback as ExecFileCallback;
        const err = Object.assign(new Error(), { code: 1 });
        fn(err, '', 'some other error');
        return {} as any;
      });

      await expect(runSonarScan(defaultOptions)).rejects.toThrow(ExecutionError);
    });

    it('throws ExecutionError for exit code 2', async () => {
      mockExecSync.mockReturnValue('');
      mockExecFile.mockImplementation((_cmd, _args, _opts, callback) => {
        const fn = callback as ExecFileCallback;
        const err = Object.assign(new Error(), { code: 2 });
        fn(err, '', '');
        return {} as any;
      });

      await expect(runSonarScan(defaultOptions)).rejects.toThrow(ExecutionError);
    });
  });

  describe('timeout handling', () => {
    it('throws ExecutionError with timeout message when process is killed', async () => {
      mockExecSync.mockReturnValue('');
      mockExecFile.mockImplementation((_cmd, _args, _opts, callback) => {
        const fn = callback as ExecFileCallback;
        const err = Object.assign(new Error(), { killed: true });
        fn(err, '', '');
        return {} as any;
      });

      try {
        await runSonarScan(defaultOptions);
        fail('should have thrown');
      } catch (e) {
        expect(e).toBeInstanceOf(ExecutionError);
        expect((e as Error).message).toContain('120000');
      }
    });

    it('throws ExecutionError with timeout message when signal is set', async () => {
      mockExecSync.mockReturnValue('');
      mockExecFile.mockImplementation((_cmd, _args, _opts, callback) => {
        const fn = callback as ExecFileCallback;
        const err = Object.assign(new Error(), { signal: 'SIGTERM' });
        fn(err, '', '');
        return {} as any;
      });

      await expect(runSonarScan(defaultOptions)).rejects.toThrow(ExecutionError);
    });

    it('passes default timeout of 120000ms to execFile', async () => {
      mockExecSync.mockReturnValue('');
      mockExecFile.mockImplementation((_cmd, _args, opts, callback) => {
        const fn = callback as ExecFileCallback;
        expect(opts ?? {}).toEqual({
          cwd: '/tmp/repo',
          timeout: 120000,
          maxBuffer: 4 * 1024 * 1024,
        });
        fn(null, '', '');
        return {} as any;
      });

      await runSonarScan(defaultOptions);
    });

    it('uses custom timeoutMs when provided', async () => {
      mockExecSync.mockReturnValue('');
      mockExecFile.mockImplementation((_cmd, _args, opts, callback) => {
        const fn = callback as ExecFileCallback;
        expect(opts?.timeout).toBe(60000);
        fn(null, '', '');
        return {} as any;
      });

      await runSonarScan({ ...defaultOptions, timeoutMs: 60000 });
    });
  });

  describe('onProgress callback', () => {
    it('emits progress when findings are detected in analyze step', async () => {
      mockExecSync.mockReturnValue('');
      const mockOnProgress = jest.fn();

      // Since secretPaths is omitted, secrets step is skipped (no execFile call)
      // So the first (and only) execFile call is the analyze step with findings
      mockExecFile.mockImplementation((_cmd, _args, _opts, callback) => {
        const fn = callback as ExecFileCallback;
        // Analyze step with findings
        const err = Object.assign(new Error(), { code: 51 });
        fn(err, '', '');
        return {} as any;
      });

      await runSonarScan({ ...defaultOptions, onProgress: mockOnProgress });

      expect(mockOnProgress).toHaveBeenCalledWith(expect.stringMatching(/finding/i));
    });
  });
});
