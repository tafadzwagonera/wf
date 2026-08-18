import * as os from 'node:os';
import * as path from 'node:path';
import {
  getWfHomeDir,
  getWfLogDir,
  getWfSessionDir,
  getWfStateDir,
  resetWfPathOverrides,
  setWfPathOverrides,
} from './wf-paths';

describe('wf path resolution', () => {
  const originalWfHome = process.env['WF_HOME'];

  afterEach(() => {
    resetWfPathOverrides();
    if (originalWfHome === undefined) delete process.env['WF_HOME'];
    else process.env['WF_HOME'] = originalWfHome;
  });

  it('defaults to ~/.wf when nothing overrides it', () => {
    delete process.env['WF_HOME'];

    expect(getWfHomeDir()).toBe(path.join(os.homedir(), '.wf'));
    expect(getWfLogDir()).toBe(path.join(os.homedir(), '.wf', 'logs'));
  });

  it('relocates the whole tree via WF_HOME so a test run cannot write to the real home', () => {
    process.env['WF_HOME'] = '/tmp/wf-home';

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
    process.env['WF_HOME'] = '/tmp/wf-home';
    setWfPathOverrides({ logDir: '/var/log/wf' });

    expect(getWfLogDir()).toBe('/var/log/wf');
    expect(getWfStateDir()).toBe(path.join('/tmp/wf-home', 'state'));
  });

  it('ignores a relative override so paths are never resolved against a shifting cwd', () => {
    setWfPathOverrides({ logDir: 'relative/logs' });

    expect(path.isAbsolute(getWfLogDir())).toBe(true);
  });

  it('restores the defaults on reset', () => {
    delete process.env['WF_HOME'];
    setWfPathOverrides({ logDir: '/var/log/wf' });
    resetWfPathOverrides();

    expect(getWfLogDir()).toBe(path.join(os.homedir(), '.wf', 'logs'));
  });
});
