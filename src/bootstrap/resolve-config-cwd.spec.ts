jest.mock('fs', () => ({
  existsSync: jest.fn(),
}));

jest.mock('node:os', () => {
  const actualOs = jest.requireActual('node:os');
  return { ...actualOs, homedir: jest.fn(() => '/home/tester') };
});

import * as fs from 'fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ConfigurationError } from '../shared/errors/app.error';
import { restoreEnv, withEnv } from '../shared/testing/env';
import { resolveConfigCwd } from './resolve-config-cwd';

describe('resolveConfigCwd', () => {
  let cwdSpy: jest.SpyInstance;
  let mockExistsSync: jest.MockedFunction<typeof fs.existsSync>;

  beforeEach(() => {
    cwdSpy = jest.spyOn(process, 'cwd').mockReturnValue('/current/wf');
    mockExistsSync = fs.existsSync as jest.MockedFunction<typeof fs.existsSync>;
    mockExistsSync.mockReset();
    mockExistsSync.mockReturnValue(false);
  });

  afterEach(() => {
    cwdSpy.mockRestore();
    jest.restoreAllMocks();
  });

  it('uses the first repo passed via -r when it resolves locally', () => {
    mockExistsSync.mockImplementation((candidate: fs.PathLike) => candidate === '/current/service-tourv3');

    expect(resolveConfigCwd(['issue', 'WBP-3054', '--from', 'plan', '-r', 'service-tourv3'])).toBe(
      '/current/service-tourv3'
    );
  });

  it('uses the first repo passed via --repos when it resolves locally', () => {
    mockExistsSync.mockImplementation((candidate: fs.PathLike) => candidate === '/current/service-tourv3');

    expect(resolveConfigCwd(['issue', 'WBP-3054', '--repos', 'service-tourv3', 'other-repo'])).toBe(
      '/current/service-tourv3'
    );
  });

  it('uses the inline --repos=value form', () => {
    mockExistsSync.mockImplementation((candidate: fs.PathLike) => candidate === '/current/service-tourv3');

    expect(resolveConfigCwd(['issue', 'WBP-3054', '--repos=service-tourv3'])).toBe('/current/service-tourv3');
  });

  it('throws ConfigurationError when the repo override is not a local checkout', () => {
    expect(() => resolveConfigCwd(['issue:review', 'CTRL-280', '--repos=api-gateway-v1'])).toThrow(ConfigurationError);
  });

  it('includes searched paths in the error message when -r repo is unresolvable', () => {
    expect(() => resolveConfigCwd(['issue:review', 'CTRL-280', '-r', 'api-gateway-v1'])).toThrow(
      /Repository 'api-gateway-v1' not found/
    );
    expect(() => resolveConfigCwd(['issue:review', 'CTRL-280', '-r', 'api-gateway-v1'])).toThrow(
      /\/current\/wf\/api-gateway-v1/
    );
    expect(() => resolveConfigCwd(['issue:review', 'CTRL-280', '-r', 'api-gateway-v1'])).toThrow(
      /\/current\/api-gateway-v1/
    );
  });

  it('falls back to process.cwd when no repo override is present', () => {
    expect(resolveConfigCwd(['issue', 'WBP-3054'])).toBe('/current/wf');
  });

  describe('when the repo lives under a repos directory', () => {
    afterEach(() => {
      restoreEnv();
    });

    it('resolves from an unrelated cwd via WF_REPOS_DIR', () => {
      withEnv({ WF_REPOS_DIR: '/checkouts' });
      mockExistsSync.mockImplementation((candidate: fs.PathLike) => candidate === '/checkouts/service-tourv3');

      const resolved = resolveConfigCwd(['issue', 'WBP-3054', '-r', 'service-tourv3']);

      expect(resolved).toBe('/checkouts/service-tourv3');
      expect(mockExistsSync.mock.calls.map(call => call[0])).toContain('/checkouts/service-tourv3');
    });

    it('resolves via a default base when WF_REPOS_DIR is unset', () => {
      withEnv({ WF_REPOS_DIR: undefined });
      const defaultPath = path.join(os.homedir(), 'Projects', 'service-tourv3');
      mockExistsSync.mockImplementation((candidate: fs.PathLike) => candidate === defaultPath);

      const resolved = resolveConfigCwd(['issue', 'WBP-3054', '-r', 'service-tourv3']);

      expect(resolved).toBe(defaultPath);
      expect(mockExistsSync.mock.calls.map(call => call[0])).toContain(defaultPath);
    });

    it('lists every repos-base candidate and the WF_REPOS_DIR hint when nothing resolves', () => {
      withEnv({ WF_REPOS_DIR: undefined });
      const defaultCandidates = ['Apps', 'Projects', 'apps', 'projects'].map(name =>
        path.join(os.homedir(), name, 'api-gateway-v1')
      );

      let message = '';
      try {
        resolveConfigCwd(['issue:review', 'CTRL-280', '-r', 'api-gateway-v1']);
      } catch (error) {
        message = (error as Error).message;
      }

      for (const candidate of defaultCandidates) {
        expect(message).toContain(candidate);
      }
      expect(message).toContain(
        'Use an absolute path, run from a parent/sibling directory, '
        + 'or set WF_REPOS_DIR to the directory containing your repositories.'
      );
    });

    it('does not probe default bases when WF_REPOS_DIR is set', () => {
      withEnv({ WF_REPOS_DIR: '/empty-checkouts' });

      expect(() => resolveConfigCwd(['issue', 'WBP-3054', '-r', 'service-tourv3'])).toThrow(
        /\/empty-checkouts\/service-tourv3/
      );
      const probed = mockExistsSync.mock.calls.map(call => String(call[0]));
      expect(probed).toContain('/empty-checkouts/service-tourv3');
      expect(probed).not.toContain(path.join(os.homedir(), 'Projects', 'service-tourv3'));
    });
  });
});
