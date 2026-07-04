import { assertCodexCliAvailable, buildCodexCliArgs, parseCodexCliVersion } from './codex-cli-runner';
import { execSync } from 'child_process';

jest.mock('child_process', () => ({
  ...jest.requireActual('child_process'),
  execSync: jest.fn(),
}));

const mockExecSync = execSync as jest.MockedFunction<typeof execSync>;

describe('codex-cli-runner', () => {
  afterEach(() => {
    jest.restoreAllMocks();
    mockExecSync.mockReset();
    delete process.env['WF_SKIP_CLI_VERSION_CHECK'];
  });

  describe('buildCodexCliArgs', () => {
    it('includes --json for new sessions', () => {
      const args = buildCodexCliArgs({
        prompt: 'test',
        model: 'gpt-5.4-mini',
        cwd: '/repo',
      });

      expect(args).toContain('exec');
      expect(args).toContain('--json');
    });

    it('includes --json for resumed sessions', () => {
      const args = buildCodexCliArgs({
        prompt: 'test',
        model: 'gpt-5.4-mini',
        cwd: '/repo',
        sessionId: 'sess-123',
      });

      expect(args).toContain('exec');
      expect(args).toContain('--json');
      expect(args).toContain('resume');
      expect(args).toContain('sess-123');
      expect(args.indexOf('--json')).toBeLessThan(args.indexOf('resume'));
    });

    it('includes model when specified', () => {
      const args = buildCodexCliArgs({
        prompt: 'test',
        model: 'gpt-5.4-mini',
        cwd: '/repo',
      });

      expect(args).toContain('--model');
      expect(args).toContain('gpt-5.4-mini');
    });

    it('includes --full-auto when permissionMode is full-auto', () => {
      const args = buildCodexCliArgs({
        prompt: 'test',
        model: 'gpt-5.4-mini',
        cwd: '/repo',
        permissionMode: 'full-auto',
      });

      expect(args).toContain('--full-auto');
    });

    it('omits --full-auto when permissionMode is not set', () => {
      const args = buildCodexCliArgs({
        prompt: 'test',
        model: 'gpt-5.4-mini',
        cwd: '/repo',
      });

      expect(args).not.toContain('--full-auto');
    });
  });

  describe('assertCodexCliAvailable', () => {
    it('does not throw when codex is available and version matches', () => {
      mockExecSync
        .mockReturnValueOnce(Buffer.from('/usr/local/bin/codex'))
        .mockReturnValueOnce('codex-cli 0.142.5' as any);
      expect(() => assertCodexCliAvailable()).not.toThrow();
    });

    it('throws with install instructions when codex is missing', () => {
      mockExecSync.mockImplementation(() => {
        throw new Error('not found');
      });
      expect(() => assertCodexCliAvailable()).toThrow(/Codex CLI is not installed/);
      expect(() => assertCodexCliAvailable()).toThrow(/github\.com\/openai\/codex/);
    });

    it('throws when the installed major version does not match', () => {
      mockExecSync
        .mockReturnValueOnce(Buffer.from('/usr/local/bin/codex'))
        .mockReturnValueOnce('codex-cli 1.0.0' as any);
      expect(() => assertCodexCliAvailable()).toThrow(/Incompatible Codex CLI version 1\.0\.0/);
    });

    it('throws when the installed minor version is too old', () => {
      mockExecSync
        .mockReturnValueOnce(Buffer.from('/usr/local/bin/codex'))
        .mockReturnValueOnce('codex-cli 0.100.0' as any);
      expect(() => assertCodexCliAvailable()).toThrow(/0\.100\.0 is too old/);
    });

    it('does not throw when the installed minor version is newer than the minimum', () => {
      mockExecSync
        .mockReturnValueOnce(Buffer.from('/usr/local/bin/codex'))
        .mockReturnValueOnce('codex-cli 0.200.0' as any);
      expect(() => assertCodexCliAvailable()).not.toThrow();
    });

    it('throws when the version output is unrecognisable', () => {
      mockExecSync.mockReturnValueOnce(Buffer.from('/usr/local/bin/codex')).mockReturnValueOnce('unknown' as any);
      expect(() => assertCodexCliAvailable()).toThrow(/Unrecognised Codex CLI version format/);
    });

    it('skips version check when WF_SKIP_CLI_VERSION_CHECK=1', () => {
      process.env['WF_SKIP_CLI_VERSION_CHECK'] = '1';
      mockExecSync.mockReturnValueOnce(Buffer.from('/usr/local/bin/codex'));
      expect(() => assertCodexCliAvailable()).not.toThrow();
      expect(mockExecSync).toHaveBeenCalledTimes(1);
    });
  });

  describe('parseCodexCliVersion', () => {
    it('parses the full codex --version output', () => {
      expect(parseCodexCliVersion('codex-cli 0.142.5')).toEqual({ major: 0, minor: 142, patch: 5 });
    });

    it('returns null for non-version strings', () => {
      expect(parseCodexCliVersion('unknown')).toBeNull();
      expect(parseCodexCliVersion('')).toBeNull();
    });

    it('handles leading and trailing whitespace', () => {
      expect(parseCodexCliVersion('  codex-cli 0.142.5  ')).toEqual({ major: 0, minor: 142, patch: 5 });
    });
  });
});
