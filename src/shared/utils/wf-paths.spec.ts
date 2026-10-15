jest.mock('node:os', () => {
  const actualOs = jest.requireActual('node:os');
  return { ...actualOs, homedir: jest.fn(() => actualOs.homedir()) };
});

import * as os from 'node:os';
import * as path from 'node:path';
import {
  getWfHomeDir,
  getWfLogDir,
  getWfReposDirs,
  getWfSessionDir,
  getWfStateDir,
  resetWfPathOverrides,
  resetWfReposDirWarning,
  setWfPathOverrides,
} from './wf-paths';
import { restoreEnv, withEnv } from '../testing/env';

describe('wf path resolution', () => {
  afterEach(() => {
    resetWfPathOverrides();
    resetWfReposDirWarning();
    restoreEnv();
    jest.restoreAllMocks();
  });

  it('defaults to ~/.wf when nothing overrides it', () => {
    withEnv({ WF_HOME: undefined });

    expect(getWfHomeDir()).toBe(path.join(os.homedir(), '.wf'));
    expect(getWfLogDir()).toBe(path.join(os.homedir(), '.wf', 'logs'));
  });

  it('relocates the whole tree via WF_HOME so a test run cannot write to the real home', () => {
    withEnv({ WF_HOME: '/tmp/wf-home' });

    expect(getWfHomeDir()).toBe('/tmp/wf-home');
    expect(getWfLogDir()).toBe(path.join('/tmp/wf-home', 'logs'));
    expect(getWfStateDir()).toBe(path.join('/tmp/wf-home', 'state'));
    expect(getWfSessionDir()).toBe(path.join('/tmp/wf-home', 'state', 'sessions'));
  });

  it('lets configured log and state directories override the derived defaults', () => {
    setWfPathOverrides({ logDir: '/var/log/wf', stateDir: '/var/lib/wf' });

    expect(getWfLogDir()).toBe('/var/log/wf');
    expect(getWfStateDir()).toBe('/var/lib/wf');
    expect(getWfSessionDir()).toBe(path.join('/var/lib/wf', 'sessions'));
  });

  it('prefers a configured directory over WF_HOME', () => {
    withEnv({ WF_HOME: '/tmp/wf-home' });
    setWfPathOverrides({ logDir: '/var/log/wf' });

    expect(getWfLogDir()).toBe('/var/log/wf');
    expect(getWfStateDir()).toBe(path.join('/tmp/wf-home', 'state'));
  });

  it('ignores a relative override so paths are never resolved against a shifting cwd', () => {
    setWfPathOverrides({ logDir: 'relative/logs' });

    expect(path.isAbsolute(getWfLogDir())).toBe(true);
  });

  it('restores the defaults on reset', () => {
    withEnv({ WF_HOME: undefined });
    setWfPathOverrides({ logDir: '/var/log/wf' });
    resetWfPathOverrides();

    expect(getWfLogDir()).toBe(path.join(os.homedir(), '.wf', 'logs'));
  });

  describe('repos directory resolution', () => {
    const mockHomedir = os.homedir as jest.Mock;
    const defaultReposDirs = ['Apps', 'Projects', 'apps', 'projects'].map(name => path.join('/home/tester', name));

    beforeEach(() => {
      mockHomedir.mockReturnValue('/home/tester');
    });

    afterEach(() => {
      mockHomedir.mockImplementation(() => jest.requireActual('node:os').homedir());
    });

    it('uses only the configured base when WF_REPOS_DIR is absolute', () => {
      withEnv({ WF_REPOS_DIR: '/work/checkouts' });

      expect(getWfReposDirs()).toEqual(['/work/checkouts']);
    });

    it('falls back to the four home-relative defaults in order when WF_REPOS_DIR is unset', () => {
      withEnv({ WF_REPOS_DIR: undefined });

      expect(getWfReposDirs()).toEqual(defaultReposDirs);
      expect(mockHomedir).toHaveBeenCalled();
    });

    it('derives the defaults from the home directory, never from WF_HOME', () => {
      withEnv({ WF_REPOS_DIR: undefined, WF_HOME: '/tmp/wf-home' });

      expect(getWfReposDirs()).toEqual(defaultReposDirs);
    });

    it('ignores a relative WF_REPOS_DIR and warns exactly once across repeated calls', () => {
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
      withEnv({ WF_REPOS_DIR: 'relative/repos' });

      const first = getWfReposDirs();
      const second = getWfReposDirs();

      expect(first).toEqual(defaultReposDirs);
      expect(second).toEqual(defaultReposDirs);
      expect(warnSpy).toHaveBeenCalledTimes(1);
      const message = String(warnSpy.mock.calls[0][0]);
      expect(message).toContain('WF_REPOS_DIR is set to a relative path');
      expect(message).toContain('relative/repos');
    });

    it('warns again after the warning state is reset', () => {
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
      withEnv({ WF_REPOS_DIR: 'relative/repos' });

      getWfReposDirs();
      resetWfReposDirWarning();
      getWfReposDirs();

      expect(warnSpy).toHaveBeenCalledTimes(2);
    });
  });
});
