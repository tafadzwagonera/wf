import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as logFileWriter from '../logger/log-file-writer';

import {
  buildGitShimEnvOverrides,
  resolveGitShimDir,
  prependToPath,
  resolveRealGitPath,
} from './git-shim-path';

jest.mock('fs', () => {
  const actual = jest.requireActual<typeof import('fs')>('fs');
  return {
    ...actual,
    existsSync: jest.fn(actual.existsSync),
    accessSync: jest.fn(actual.accessSync),
    writeFileSync: jest.fn(actual.writeFileSync),
  };
});

const mockHomedir = jest.fn();
const mockIsSea = jest.fn();
const mockGetAsset = jest.fn();

jest.mock('os', () => {
  const actual = jest.requireActual<typeof import('os')>('os');
  return { ...actual, homedir: (...args: unknown[]) => mockHomedir(...args) };
});

jest.mock('node:sea', () => ({
  isSea: (...args: unknown[]) => mockIsSea(...args),
  getAsset: (...args: unknown[]) => mockGetAsset(...args),
}));

describe('prependToPath', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('prepends dir to a non-empty path', () => {
    expect(prependToPath('/shim', '/usr/bin:/bin', ':')).toBe('/shim:/usr/bin:/bin');
  });

  it('is idempotent when dir is already first', () => {
    expect(prependToPath('/shim', '/shim:/usr/bin', ':')).toBe('/shim:/usr/bin');
  });

  it('handles undefined currentPath', () => {
    expect(prependToPath('/shim', undefined, ':')).toBe('/shim');
  });

  it('handles empty currentPath', () => {
    expect(prependToPath('/shim', '', ':')).toBe('/shim');
  });
});

describe('resolveRealGitPath', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('returns first git on PATH that is not the shim dir', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'git-shim-test-'));
    const gitPath = path.join(tmp, 'git');
    fs.writeFileSync(gitPath, '#!/bin/sh\n', { mode: 0o755 });

    const result = resolveRealGitPath(tmp, '/some/shim');
    expect(result).toBe(gitPath);

    fs.rmSync(tmp, { recursive: true });
  });

  it('skips the shim dir itself', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'git-shim-test-'));
    const gitPath = path.join(tmp, 'git');
    fs.writeFileSync(gitPath, '#!/bin/sh\n', { mode: 0o755 });

    const result = resolveRealGitPath(tmp, tmp);
    expect(result).toBeUndefined();

    fs.rmSync(tmp, { recursive: true });
  });

  it('returns undefined when no git found outside shim dir', () => {
    expect(resolveRealGitPath('/no/such/dir', '/no/such/dir')).toBeUndefined();
  });
});

describe('buildGitShimEnvOverrides', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('returns {} on win32', () => {
    const orig = process.platform;
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    expect(buildGitShimEnvOverrides({})).toEqual({});
    Object.defineProperty(process, 'platform', { value: orig, configurable: true });
  });

  it('returns {} when shim file does not exist', () => {
    jest.spyOn(fs, 'accessSync').mockImplementation(() => {
      throw new Error('ENOENT');
    });
    expect(buildGitShimEnvOverrides({})).toEqual({});
  });

  it('returns {} when shim is not executable', () => {
    jest.spyOn(fs, 'accessSync').mockImplementation(() => {
      throw new Error('permission denied');
    });
    expect(buildGitShimEnvOverrides({})).toEqual({});
  });

  it('PATH override contains the shim dir when shim is executable', () => {
    jest.spyOn(fs, 'accessSync').mockImplementation(() => {});

    const overrides = buildGitShimEnvOverrides({ PATH: '/usr/bin' });

    expect(overrides.PATH).toMatch(/bootstrap\/git-shim/);
  });

  it('PATH override prepends shim dir before existing PATH entries', () => {
    jest.spyOn(fs, 'accessSync').mockImplementationOnce(() => {})
      .mockImplementation(() => { throw new Error('not executable'); });

    const overrides = buildGitShimEnvOverrides({ PATH: '/usr/bin:/bin' });

    expect(overrides.PATH).toMatch(/bootstrap\/git-shim/);
    expect(overrides.PATH?.split(path.delimiter)[0]).toMatch(/bootstrap\/git-shim$/);
    expect(overrides.PATH).toContain('/usr/bin:/bin');
  });
});

describe('resolveGitShimDir', () => {
  let tmpHome: string;
  const mockWriteFileSync = fs.writeFileSync as jest.Mock;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'git-shim-home-'));
    mockHomedir.mockReturnValue(tmpHome);
    mockIsSea.mockReturnValue(true);
    mockGetAsset.mockReturnValue('#!/bin/sh\nexec git "$@"\n');
    mockWriteFileSync.mockClear();
  });

  afterEach(() => {
    jest.restoreAllMocks();
    mockIsSea.mockReset();
    mockGetAsset.mockReset();
    fs.rmSync(tmpHome, { recursive: true });
  });

  it('extracts the embedded shim to ~/.wf/bin/git-shim with mode 0755', () => {
    const shimDir = resolveGitShimDir();

    const shimFile = path.join(tmpHome, '.wf', 'bin', 'git-shim', 'git');
    expect(shimDir).toBe(path.join(tmpHome, '.wf', 'bin', 'git-shim'));
    expect(fs.statSync(shimFile).mode & 0o777).toBe(0o755);
    expect(mockGetAsset.mock.calls[0]).toEqual(['bootstrap/git-shim/git', 'utf8']);
    expect(mockWriteFileSync).toHaveBeenCalledTimes(1);
    expect(String(mockWriteFileSync.mock.calls[0][0]).startsWith(shimFile)).toBe(true);
  });

  it('does not rewrite the shim when the content hash is unchanged', () => {
    resolveGitShimDir();
    mockWriteFileSync.mockClear();

    resolveGitShimDir();

    expect(mockWriteFileSync).not.toHaveBeenCalled();
  });

  it('rewrites the shim when the embedded content changes', () => {
    resolveGitShimDir();
    mockWriteFileSync.mockClear();
    mockGetAsset.mockReturnValue('#!/bin/sh\necho changed\n');

    resolveGitShimDir();

    expect(mockWriteFileSync).toHaveBeenCalledTimes(1);
  });
});

describe('buildGitShimEnvOverrides when SEA extraction fails', () => {
  afterEach(() => {
    jest.restoreAllMocks();
    mockIsSea.mockReset();
    mockGetAsset.mockReset();
  });

  it('returns {} and logs a warning instead of throwing', () => {
    mockIsSea.mockReturnValue(true);
    mockGetAsset.mockImplementation(() => {
      throw new Error('asset not found');
    });
    const mockAppendToLogFile = jest.spyOn(logFileWriter, 'appendToLogFile').mockImplementation(() => undefined);

    const overrides = buildGitShimEnvOverrides({ PATH: '/usr/bin' });

    expect(overrides).toEqual({});
    expect(mockAppendToLogFile).toHaveBeenCalledTimes(1);
    expect(mockAppendToLogFile.mock.calls[0][0]).toBe('WARN');
    expect(mockAppendToLogFile.mock.calls[0][1]).toContain('asset not found');
  });
});
