import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  buildGitShimEnvOverrides,
  prependToPath,
  resolveRealGitPath,
} from './git-shim-path';

jest.mock('fs', () => {
  const actual = jest.requireActual<typeof import('fs')>('fs');
  return {
    ...actual,
    existsSync: jest.fn(actual.existsSync),
    accessSync: jest.fn(actual.accessSync),
  };
});

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
