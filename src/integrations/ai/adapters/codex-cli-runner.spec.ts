import {
  assertCodexCliAvailable, buildCodexCliArgs, buildInactivityTimeoutMessage, buildTimeoutMessage,
  extractCodexErrorMessages, getCodexCliVersion, parseCodexCliVersion,
  resetCodexCliVersionCache,
} from './codex-cli-runner';
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
    resetCodexCliVersionCache();
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

    describe('version-aware auto-approval flag', () => {
      const baseParams = { prompt: 'test', model: 'gpt-5.4-mini', cwd: '/repo', permissionMode: 'full-auto' as const };

      it.each([
        ['v0.147.0', { major: 0, minor: 147, patch: 0 }],
        ['v0.200.0', { major: 0, minor: 200, patch: 0 }],
      ])('uses --sandbox workspace-write for %s', (_label, codexVersion) => {
        const args = buildCodexCliArgs({ ...baseParams, codexVersion });
        expect(args.join(' ')).toContain('--sandbox workspace-write');
        expect(args).not.toContain('--full-auto');
      });

      it.each([
        ['v0.146.9', { major: 0, minor: 146, patch: 9 }],
        ['v0.142.0', { major: 0, minor: 142, patch: 0 }],
      ])('uses --full-auto for %s', (_label, codexVersion) => {
        const args = buildCodexCliArgs({ ...baseParams, codexVersion });
        expect(args).toContain('--full-auto');
        expect(args).not.toContain('--sandbox');
      });

      it('defaults to --full-auto when codexVersion is omitted', () => {
        const args = buildCodexCliArgs(baseParams);
        expect(args).toContain('--full-auto');
        expect(args).not.toContain('--sandbox');
      });

      it('omits auto-approval flags when permissionMode is not full-auto', () => {
        const args = buildCodexCliArgs({
          prompt: 'test', model: 'gpt-5.4-mini', cwd: '/repo',
          codexVersion: { major: 0, minor: 147, patch: 0 },
        });
        expect(args).not.toContain('--full-auto');
        expect(args).not.toContain('--sandbox');
      });
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

  describe('version cache', () => {
    it('caches parsed version after assertCodexCliAvailable succeeds', () => {
      mockExecSync
        .mockReturnValueOnce(Buffer.from('/usr/local/bin/codex'))
        .mockReturnValueOnce('codex-cli 0.147.0' as any);
      assertCodexCliAvailable();
      expect(getCodexCliVersion()).toEqual({ major: 0, minor: 147, patch: 0 });
    });

    it('returns undefined when version check is skipped', () => {
      process.env['WF_SKIP_CLI_VERSION_CHECK'] = '1';
      mockExecSync.mockReturnValueOnce(Buffer.from('/usr/local/bin/codex'));
      assertCodexCliAvailable();
      expect(getCodexCliVersion()).toBeUndefined();
    });

    it('clears cached version via resetCodexCliVersionCache', () => {
      mockExecSync
        .mockReturnValueOnce(Buffer.from('/usr/local/bin/codex'))
        .mockReturnValueOnce('codex-cli 0.147.0' as any);
      assertCodexCliAvailable();
      expect(getCodexCliVersion()).toBeDefined();
      resetCodexCliVersionCache();
      expect(getCodexCliVersion()).toBeUndefined();
    });
  });

  describe('extractCodexErrorMessages', () => {
    it('extracts a plain ERROR line', () => {
      expect(extractCodexErrorMessages('ERROR: something broke')).toBe('something broke');
    });

    it('returns full stderr when no ERROR lines found', () => {
      const stderr = 'warning: some noise\nother output';
      expect(extractCodexErrorMessages(stderr)).toBe(stderr);
    });

    it('deduplicates multiple ERROR lines', () => {
      const stderr = 'ERROR: auth failed\ninfo: ignored\nERROR: auth failed\nERROR: timeout';
      expect(extractCodexErrorMessages(stderr)).toBe('auth failed; timeout');
    });

    it('parses JSON error payloads', () => {
      const json = JSON.stringify({ error: { message: 'rate limit exceeded' } });
      expect(extractCodexErrorMessages(`ERROR: ${json}`)).toBe('rate limit exceeded');
    });

    it('falls back to raw text when JSON lacks error.message', () => {
      const json = JSON.stringify({ status: 500 });
      expect(extractCodexErrorMessages(`ERROR: ${json}`)).toBe(json);
    });

    it('returns empty string for empty stderr', () => {
      expect(extractCodexErrorMessages('')).toBe('');
    });
  });

  describe('buildTimeoutMessage', () => {
    it('produces an error message with the timeout in seconds', () => {
      const msg = buildTimeoutMessage(600_000);
      expect(msg.type).toBe('error');
      expect(msg.subtype).toBe('timeout');
      expect(msg.is_error).toBe(true);
      expect(msg.result).toContain('600s');
    });

    it('rounds fractional seconds', () => {
      const msg = buildTimeoutMessage(90_500);
      expect(msg.result).toContain('91s');
    });
  });

  describe('buildInactivityTimeoutMessage', () => {
    it('produces an inactivity_timeout subtype with the timeout in seconds', () => {
      const msg = buildInactivityTimeoutMessage(120_000);
      expect(msg.type).toBe('error');
      expect(msg.subtype).toBe('inactivity_timeout');
      expect(msg.is_error).toBe(true);
      expect(msg.result).toContain('120s');
      expect(msg.result).toContain('inactivity');
    });

    it('rounds fractional seconds', () => {
      const msg = buildInactivityTimeoutMessage(90_500);
      expect(msg.result).toContain('91s');
    });
  });
});
