import * as fs from 'node:fs';
import * as childProcess from 'node:child_process';
import * as path from 'node:path';
import {
  hasSonarProjectProperties,
  runSonarScan,
  buildSkippedSonarResult,
  shouldWaiveSonarScan,
} from './sonar-scanner';

jest.mock('node:fs');
jest.mock('node:child_process');

const mockExistsSync = fs.existsSync as jest.MockedFunction<typeof fs.existsSync>;
const mockExec = childProcess.exec as jest.MockedFunction<typeof childProcess.exec>;

afterEach(() => {
  jest.restoreAllMocks();
});

describe('hasSonarProjectProperties', () => {
  it('returns true when sonar-project.properties exists in repoDir', () => {
    mockExistsSync.mockReturnValue(true);

    const result = hasSonarProjectProperties('/some/repo');

    expect(result).toBe(true);
    expect(mockExistsSync).toHaveBeenCalledWith(path.join('/some/repo', 'sonar-project.properties'));
  });

  it('returns false when sonar-project.properties does not exist', () => {
    mockExistsSync.mockReturnValue(false);

    const result = hasSonarProjectProperties('/some/repo');

    expect(result).toBe(false);
  });
});

describe('runSonarScan', () => {
  it('captures stdout and stderr on success', async () => {
    mockExec.mockImplementation((_cmd, _opts, callback) => {
      (callback as (e: Error | null, stdout: string, stderr: string) => void)(null, 'ok', 'warn');
      return {} as childProcess.ChildProcess;
    });

    const result = await runSonarScan({ repoDir: '/some/repo' });

    expect(result).toEqual({ stdout: 'ok', stderr: 'warn', exitCode: 0, skipped: false });
  });

  it('returns graceful result on non-zero exit', async () => {
    mockExec.mockImplementation((_cmd, _opts, callback) => {
      const err = Object.assign(new Error('fail'), { code: 1, stdout: 'partial', stderr: 'fail' });
      (callback as (e: Error | null, stdout: string, stderr: string) => void)(err, 'partial', 'fail');
      return {} as childProcess.ChildProcess;
    });

    const result = await runSonarScan({ repoDir: '/some/repo' });

    expect(result).toEqual({ stdout: 'partial', stderr: 'fail', exitCode: 1, skipped: false });
  });

  it('calls onProgress before running the scan', async () => {
    mockExec.mockImplementation((_cmd, _opts, callback) => {
      (callback as (e: Error | null, stdout: string, stderr: string) => void)(null, 'done', '');
      return {} as childProcess.ChildProcess;
    });
    const onProgress = jest.fn();

    await runSonarScan({ repoDir: '/some/repo', onProgress });

    expect(onProgress).toHaveBeenCalledWith('Running SonarScanner...');
  });

  it('uses default timeoutInMs of 120000', async () => {
    mockExec.mockImplementation((_cmd, opts, callback) => {
      (callback as (e: Error | null, stdout: string, stderr: string) => void)(null, '', '');
      return {} as childProcess.ChildProcess;
    });

    await runSonarScan({ repoDir: '/some/repo' });

    expect(mockExec).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ timeout: 120_000 }),
      expect.any(Function)
    );
  });
});

describe('buildSkippedSonarResult', () => {
  it('returns a skipped result with the given reason', () => {
    const result = buildSkippedSonarResult('test reason');

    expect(result).toEqual({ stdout: '', stderr: '', exitCode: 0, skipped: true, skipReason: 'test reason' });
  });
});

describe('shouldWaiveSonarScan', () => {
  it('returns true when estimatedComplexity is high', () => {
    expect(shouldWaiveSonarScan('high', undefined)).toBe(true);
  });

  it('returns true when passCount is greater than 5', () => {
    expect(shouldWaiveSonarScan(undefined, 6)).toBe(true);
  });

  it('returns false when passCount is exactly 5 (strict greater-than)', () => {
    expect(shouldWaiveSonarScan(undefined, 5)).toBe(false);
  });

  it('returns false when both estimatedComplexity and passCount are undefined', () => {
    expect(shouldWaiveSonarScan(undefined, undefined)).toBe(false);
  });
});
