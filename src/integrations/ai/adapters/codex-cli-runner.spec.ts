import { EventEmitter } from 'events';
import { Readable, Writable } from 'stream';
import {
  assertCodexCliAvailable, buildCodexCliArgs, buildCodexStdinPrompt, buildInactivityTimeoutMessage,
  buildTimeoutMessage, extractCodexErrorMessages, getCodexCliVersion, parseCodexCliVersion,
  resetCodexCliVersionCache, spawnCodex, type CodexCliMessage,
} from './codex-cli-runner';
import { execSync, spawn } from 'child_process';
import { restoreEnv, withEnv } from '../../../common/testing/env';

jest.mock('child_process', () => ({
  ...jest.requireActual('child_process'),
  execSync: jest.fn(),
  spawn: jest.fn(),
}));

const mockExecSync = execSync as jest.MockedFunction<typeof execSync>;
const mockSpawn = spawn as jest.MockedFunction<typeof spawn>;

const createMockCodexProcess = () => {
  const stdout = new Readable({ read() {} });
  const stderr = new Readable({ read() {} });
  const stdin = new Writable({
    write(_chunk, _enc, cb) {
      cb();
    },
  });
  return Object.assign(new EventEmitter(), {
    stdout,
    stderr,
    stdin,
    pid: 5678,
    killed: false,
    kill: jest.fn(function (this: { killed: boolean }) {
      this.killed = true;
      stdout.push(null);
    }),
  });
};

describe('codex-cli-runner', () => {
  beforeEach(() => withEnv({ WF_SKIP_CLI_VERSION_CHECK: undefined }));

  afterEach(() => {
    restoreEnv();
    jest.restoreAllMocks();
    mockExecSync.mockReset();
    resetCodexCliVersionCache();
  });

  describe('buildCodexStdinPrompt', () => {
    it('returns base prompt when no screenshots provided', () => {
      const result = buildCodexStdinPrompt({ prompt: 'implement this' });
      expect(result).toBe('implement this');
    });

    it('returns base prompt when screenshots array is empty', () => {
      const result = buildCodexStdinPrompt({ prompt: 'implement this', screenshots: [] });
      expect(result).toBe('implement this');
    });

    it('appends screenshot paths when screenshots are present', () => {
      const result = buildCodexStdinPrompt({
        prompt: 'implement this',
        screenshots: [
          { path: '/tmp/a.png', mediaType: 'image/png', base64: 'x' },
          { path: '/tmp/b.jpg', mediaType: 'image/jpeg', base64: 'y' },
        ],
      });
      expect(result).toContain('Design screenshots (accessible via filesystem):');
      expect(result).toContain('- /tmp/a.png');
      expect(result).toContain('- /tmp/b.jpg');
      expect(result).toContain('You MUST open and inspect every screenshot');
      expect(result.indexOf('implement this')).toBeLessThan(result.indexOf('Design screenshots'));
    });
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

    it('builds resumed sessions with supported Codex exec resume flags', () => {
      const args = buildCodexCliArgs({
        prompt: 'test',
        model: 'gpt-5.4-mini',
        cwd: '/repo',
        sessionId: 'sess-123',
      });

      expect(args).toEqual(['exec', '--json', 'resume', 'sess-123', '--model', 'gpt-5.4-mini']);
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

    it('includes the output schema path for structured responses', () => {
      const args = buildCodexCliArgs({
        prompt: 'test', model: 'gpt-5.4-mini', cwd: '/repo', outputSchemaPath: '/tmp/schema.json',
      });
      expect(args).toContain('--output-schema');
      expect(args).toContain('/tmp/schema.json');
    });

    it('includes the output schema path when resuming', () => {
      const args = buildCodexCliArgs({
        prompt: 'test', model: 'gpt-5.4-mini', cwd: '/repo', sessionId: 'session-1',
        outputSchemaPath: '/tmp/schema.json',
      });
      expect(args).toEqual(expect.arrayContaining(['resume', 'session-1', '--output-schema', '/tmp/schema.json']));
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
      withEnv({ WF_SKIP_CLI_VERSION_CHECK: '1' });
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
      withEnv({ WF_SKIP_CLI_VERSION_CHECK: '1' });
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

  describe('spawnCodex', () => {
    // The runner signals the child's process group. The mock child's pid is fictional, so a
    // real process.kill would signal an unrelated group on the host machine.
    let mockProcessKill: jest.SpyInstance;

    beforeEach(() => {
      mockProcessKill = jest.spyOn(process, 'kill').mockImplementation(() => true);
    });

    afterEach(() => {
      mockProcessKill.mockRestore();
      mockSpawn.mockReset();
    });

    it('spawns the child detached so it leads its own process group', async () => {
      const child = createMockCodexProcess();
      mockSpawn.mockReturnValue(child as never);

      const gen = spawnCodex(['exec'], '/repo', 'test');
      child.stdout.push(null);
      for await (const _msg of gen) {
        // drain
      }

      expect(mockSpawn).toHaveBeenCalledWith(
        'codex',
        expect.any(Array),
        expect.objectContaining({ detached: true })
      );
    });

    it('marks the child env as a wf-managed session so interactive-only hooks can skip', async () => {
      const child = createMockCodexProcess();
      mockSpawn.mockReturnValue(child as never);

      const gen = spawnCodex(['exec'], '/repo', 'test');
      child.stdout.push(null);
      for await (const _msg of gen) {
        // drain
      }

      expect(mockSpawn).toHaveBeenCalledWith(
        'codex',
        expect.any(Array),
        expect.objectContaining({ env: expect.objectContaining({ WF_MANAGED_SESSION: '1' }) })
      );
    });

    it('keeps the wf-managed session marker when caller env overrides are supplied', async () => {
      const child = createMockCodexProcess();
      mockSpawn.mockReturnValue(child as never);

      const gen = spawnCodex(['exec'], '/repo', 'test', { CODEX_HOME: '/custom' });
      child.stdout.push(null);
      for await (const _msg of gen) {
        // drain
      }

      expect(mockSpawn).toHaveBeenCalledWith(
        'codex',
        expect.any(Array),
        expect.objectContaining({
          env: expect.objectContaining({ WF_MANAGED_SESSION: '1', CODEX_HOME: '/custom' }),
        })
      );
    });

    it('strips OPENAI_API_KEY from the spawned child env so headless mode bills the authenticated account', async () => {
      withEnv({ OPENAI_API_KEY: 'sk-openai-leaked' });
      const child = createMockCodexProcess();
      mockSpawn.mockReturnValue(child as never);

      const gen = spawnCodex(['exec'], '/repo', 'test');
      child.stdout.push(null);
      for await (const _msg of gen) {
        // drain
      }

      const spawnEnv: Record<string, string> = mockSpawn.mock.calls[0][2].env as Record<string, string>;
      expect(spawnEnv.OPENAI_API_KEY).toBeUndefined();
    });

    it('prepends the git shim dir to PATH in the spawned child env', async () => {
      const child = createMockCodexProcess();
      mockSpawn.mockReturnValue(child as never);

      const gen = spawnCodex(['exec'], '/repo', 'test');
      child.stdout.push(null);
      for await (const _msg of gen) {
        // drain
      }

      const spawnEnv: Record<string, string> = mockSpawn.mock.calls[0][2].env as Record<string, string>;
      expect(spawnEnv.PATH).toMatch(/bootstrap\/git-shim/);
    });

    it('kills the whole process group so verification subprocesses cannot outlive the run', async () => {
      const child = createMockCodexProcess();
      mockSpawn.mockReturnValue(child as never);

      const gen = spawnCodex(['exec'], '/repo', 'test', undefined, 100);
      child.stdout.push('{"type":"item.completed"}\n');
      for await (const _msg of gen) {
        // drain until the wall-clock kill fires
      }

      expect(mockProcessKill).toHaveBeenCalledWith(-child.pid, 'SIGTERM');
    });

    const agentMessageLine = (): string =>
      `${JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'no edits' } })}\n`;
    const commandCompletedLine = (): string =>
      `${JSON.stringify({ type: 'item.completed', item: { type: 'command_execution', command: 'true', exit_code: 0 } })}\n`;

    it('aborts as stalled after ten consecutive agent messages with no command activity', async () => {
      const child = createMockCodexProcess();
      mockSpawn.mockReturnValue(child as never);

      const gen = spawnCodex(['exec'], '/repo', 'test', undefined, 2000);
      for (let i = 0; i < 10; i++) child.stdout.push(agentMessageLine());
      const messages: CodexCliMessage[] = [];
      for await (const msg of gen) messages.push(msg);

      expect(messages.at(-1)).toMatchObject({ type: 'error', subtype: 'no_progress', is_error: true });
      expect(mockProcessKill).toHaveBeenCalledWith(-child.pid, 'SIGTERM');
    });

    it('does not abort when command activity interleaves the agent messages', async () => {
      const child = createMockCodexProcess();
      mockSpawn.mockReturnValue(child as never);

      const gen = spawnCodex(['exec'], '/repo', 'test', undefined, 2000);
      for (let i = 0; i < 9; i++) child.stdout.push(agentMessageLine());
      child.stdout.push(commandCompletedLine());
      for (let i = 0; i < 9; i++) child.stdout.push(agentMessageLine());
      child.stdout.push(null);
      const messages: CodexCliMessage[] = [];
      for await (const msg of gen) messages.push(msg);

      expect(messages.filter(m => m.subtype === 'no_progress')).toEqual([]);
      expect(messages).toHaveLength(19);
    });

    it('lets the inactivity timeout fire while only agent messages arrive', async () => {
      const child = createMockCodexProcess();
      mockSpawn.mockReturnValue(child as never);

      const gen = spawnCodex(['exec'], '/repo', 'test', undefined, 0, 120);
      let pushes = 0;
      const pump = setInterval(() => {
        if (!child.killed && pushes < 20) {
          child.stdout.push(agentMessageLine());
          pushes++;
        }
      }, 50);
      const messages: CodexCliMessage[] = [];
      for await (const msg of gen) messages.push(msg);
      clearInterval(pump);

      expect(messages.at(-1)).toMatchObject({ type: 'error', subtype: 'inactivity_timeout' });
      expect(messages.length).toBeLessThan(6);
    });
  });
});
