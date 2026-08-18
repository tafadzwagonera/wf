import * as fs from 'node:fs';
import * as childProcess from 'node:child_process';
import * as path from 'node:path';
import {
  hasSonarProjectProperties,
  runSonarScan,
  buildSkippedSonarResult,
  runSonarScanForReview,
} from './sonar-scanner';
import { ConfigurationError } from '../shared/utils/errors';

jest.mock('node:fs');
jest.mock('node:child_process', () => ({
  ...jest.requireActual('node:child_process'),
  exec: jest.fn(),
  execFile: jest.fn(),
  execFileSync: jest.fn(),
  execSync: jest.fn(),
  spawn: jest.fn(),
  spawnSync: jest.fn(),
}));

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

describe('runSonarScanForReview', () => {
  beforeEach(() => {
    mockExec.mockClear();
    mockExistsSync.mockReset();
  });

  it('throws when repoDir is undefined', async () => {
    const onProgress = jest.fn();

    await expect(runSonarScanForReview({ onProgress })).rejects.toBeInstanceOf(ConfigurationError);
    expect(onProgress).not.toHaveBeenCalled();
    expect(mockExec).not.toHaveBeenCalled();
  });

  it('skips when sonar-project.properties does not exist', async () => {
    mockExistsSync.mockReturnValue(false);
    const onProgress = jest.fn();

    await runSonarScanForReview({ repoDir: '/some/repo', onProgress });

    expect(onProgress).toHaveBeenCalledWith('SonarScanner skipped: no sonar-project.properties found');
    expect(mockExec).not.toHaveBeenCalled();
  });

  it('runs scan and logs output when no guard fires', async () => {
    mockExistsSync.mockImplementation(p =>
      String(p).endsWith('sonar-project.properties')
    );
    jest.spyOn(fs, 'readFileSync').mockReturnValue('sonar.projectKey=wf\n');
    mockExec.mockImplementation((_cmd, _opts, callback) => {
      (callback as (e: Error | null, stdout: string, stderr: string) => void)(null, 'INFO: done', '');
      return {} as childProcess.ChildProcess;
    });
    const onProgress = jest.fn();

    await runSonarScanForReview({ repoDir: '/some/repo', onProgress });

    expect(mockExec).toHaveBeenCalled();
    expect(onProgress).toHaveBeenCalledWith('INFO: done');
  });

  it('logs exit code when scan fails', async () => {
    mockExistsSync.mockImplementation(p =>
      String(p).endsWith('sonar-project.properties')
    );
    jest.spyOn(fs, 'readFileSync').mockReturnValue('sonar.projectKey=wf\n');
    mockExec.mockImplementation((_cmd, _opts, callback) => {
      const err = Object.assign(new Error('fail'), { code: 1, stdout: '', stderr: 'error' });
      (callback as (e: Error | null, stdout: string, stderr: string) => void)(err, '', 'error');
      return {} as childProcess.ChildProcess;
    });
    const onProgress = jest.fn();

    await runSonarScanForReview({ repoDir: '/some/repo', onProgress });

    expect(onProgress).toHaveBeenCalledWith('SonarScanner exited with code 1');
  });
});
