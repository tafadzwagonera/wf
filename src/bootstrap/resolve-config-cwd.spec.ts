jest.mock('fs', () => ({
  existsSync: jest.fn(),
}));

import * as fs from 'fs';
import { ConfigurationError } from '../shared/errors/app.error';
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
});
