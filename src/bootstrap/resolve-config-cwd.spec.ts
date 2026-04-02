jest.mock('../agents/utils', () => ({
  resolveRepoBasePath: jest.fn((repo?: string) =>
    repo ? `/resolved/${repo}` : '/resolved/cwd',
  ),
}));

import { resolveConfigCwd } from './resolve-config-cwd';

describe('resolveConfigCwd', () => {
  let cwdSpy: jest.SpyInstance;

  beforeEach(() => {
    cwdSpy = jest.spyOn(process, 'cwd').mockReturnValue('/current/wf');
  });

  afterEach(() => {
    cwdSpy.mockRestore();
  });

  it('uses the first repo passed via -r', () => {
    expect(
      resolveConfigCwd([
        'issue',
        'WBP-3054',
        '--from',
        'plan',
        '-r',
        'service-tourv3',
      ]),
    ).toBe('/resolved/service-tourv3');
  });

  it('uses the first repo passed via --repos', () => {
    expect(
      resolveConfigCwd([
        'issue',
        'WBP-3054',
        '--repos',
        'service-tourv3',
        'other-repo',
      ]),
    ).toBe('/resolved/service-tourv3');
  });

  it('uses the inline --repos=value form', () => {
    expect(
      resolveConfigCwd(['issue', 'WBP-3054', '--repos=service-tourv3']),
    ).toBe('/resolved/service-tourv3');
  });

  it('falls back to process.cwd when no repo override is present', () => {
    expect(resolveConfigCwd(['issue', 'WBP-3054'])).toBe('/current/wf');
  });
});
