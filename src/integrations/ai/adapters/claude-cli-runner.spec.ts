import {
  assertClaudeCliAvailable,
  buildCliArgs,
  type ClaudeCliMessage,
  isSystemChatter,
  parseClaudeCliVersion,
  parseNdjsonLine,
  spawnCli,
} from './claude-cli-runner';
import * as logFileWriter from '../../../shared/logger/log-file-writer';
import { execSync, spawn } from 'child_process';
import { EventEmitter, Readable, Writable } from 'stream';

jest.mock('child_process', () => ({
  ...jest.requireActual('child_process'),
  execSync: jest.fn(),
  spawn: jest.fn(),
}));

const mockExecSync = execSync as jest.MockedFunction<typeof execSync>;
const mockSpawn = spawn as jest.MockedFunction<typeof spawn>;

const createMockChildProcess = () => {
  const stdout = new Readable({ read() {} });
  const stderr = new Readable({ read() {} });
  const stdin = new Writable({
    write(_chunk, _enc, cb) {
      cb();
    },
  });
  const child = Object.assign(new EventEmitter(), {
    stdout,
    stderr,
    stdin,
    pid: 1234,
    killed: false,
    kill: jest.fn(function (this: { killed: boolean }) {
      this.killed = true;
      stdout.push(null);
    }),
  });
  return child;
};

describe('claude-cli-runner', () => {
  describe('assertClaudeCliAvailable', () => {
    afterEach(() => {
      jest.restoreAllMocks();
      mockExecSync.mockReset();
      delete process.env['WF_SKIP_CLI_VERSION_CHECK'];
    });

    it('does not throw when claude is available', () => {
      mockExecSync
        .mockReturnValueOnce(Buffer.from('/usr/local/bin/claude'))
        .mockReturnValueOnce('2.1.228 (Claude Code)' as any);
      expect(() => assertClaudeCliAvailable()).not.toThrow();
    });

    it('throws with install instructions when claude is missing', () => {
      mockExecSync.mockImplementation(() => {
        throw new Error('not found');
      });
      expect(() => assertClaudeCliAvailable()).toThrow(/Claude CLI is not installed/);
      expect(() => assertClaudeCliAvailable()).toThrow(/docs\.anthropic\.com/);
    });

    it('throws when the installed major version does not match', () => {
      mockExecSync.mockReturnValueOnce(Buffer.from('/usr/local/bin/claude')).mockReturnValueOnce('3.0.0' as any);
      expect(() => assertClaudeCliAvailable()).toThrow(/Incompatible Claude CLI version 3\.0\.0/);
    });

    it('throws when the installed minor version is too old', () => {
      mockExecSync.mockReturnValueOnce(Buffer.from('/usr/local/bin/claude')).mockReturnValueOnce('2.0.5' as any);
      expect(() => assertClaudeCliAvailable()).toThrow(/2\.0\.5 is too old/);
    });

    it('throws when the installed patch version is too old', () => {
      mockExecSync
        .mockReturnValueOnce(Buffer.from('/usr/local/bin/claude'))
        .mockReturnValueOnce('2.1.80 (Claude Code)' as any);
      expect(() => assertClaudeCliAvailable()).toThrow(/2\.1\.80 is too old/);
    });

    it('does not throw when the installed patch matches the minimum', () => {
      mockExecSync
        .mockReturnValueOnce(Buffer.from('/usr/local/bin/claude'))
        .mockReturnValueOnce('2.1.219 (Claude Code)' as any);
      expect(() => assertClaudeCliAvailable()).not.toThrow();
    });

    it('does not throw when the installed minor version is newer than the minimum', () => {
      mockExecSync.mockReturnValueOnce(Buffer.from('/usr/local/bin/claude')).mockReturnValueOnce('2.3.0' as any);
      expect(() => assertClaudeCliAvailable()).not.toThrow();
    });

    it('throws when the version output is unrecognisable', () => {
      mockExecSync.mockReturnValueOnce(Buffer.from('/usr/local/bin/claude')).mockReturnValueOnce('unknown' as any);
      expect(() => assertClaudeCliAvailable()).toThrow(/Unrecognised Claude CLI version format/);
    });

    it('skips version check when WF_SKIP_CLI_VERSION_CHECK=1', () => {
      process.env['WF_SKIP_CLI_VERSION_CHECK'] = '1';
      mockExecSync.mockReturnValueOnce(Buffer.from('/usr/local/bin/claude'));
      expect(() => assertClaudeCliAvailable()).not.toThrow();
      expect(mockExecSync).toHaveBeenCalledTimes(1);
    });
  });

  describe('parseClaudeCliVersion', () => {
    it('parses the full claude --version output', () => {
      expect(parseClaudeCliVersion('2.1.80 (Claude Code)')).toEqual({ major: 2, minor: 1, patch: 80 });
    });

    it('parses a bare semver triple', () => {
      expect(parseClaudeCliVersion('2.1.80')).toEqual({ major: 2, minor: 1, patch: 80 });
    });

    it('returns null for non-version strings', () => {
      expect(parseClaudeCliVersion('unknown')).toBeNull();
      expect(parseClaudeCliVersion('')).toBeNull();
    });

    it('handles leading and trailing whitespace', () => {
      expect(parseClaudeCliVersion('  2.1.80 (Claude Code)  ')).toEqual({ major: 2, minor: 1, patch: 80 });
    });
  });

  describe('buildCliArgs', () => {
    it('builds args with model, output format, and verbose (prompt excluded — piped via stdin)', () => {
      const args = buildCliArgs({
        prompt: 'test prompt',
        model: 'claude-sonnet-4-6',
        cwd: '/repo',
      });

      expect(args).toContain('-p');
      expect(args).toContain('--verbose');
      expect(args).toContain('--output-format');
      expect(args).toContain('stream-json');
      expect(args).toContain('--model');
      expect(args).toContain('claude-sonnet-4-6');
      expect(args).not.toContain('test prompt');
    });

    it('includes permission mode when specified', () => {
      const args = buildCliArgs({
        prompt: 'test',
        model: 'claude-sonnet-4-6',
        cwd: '/repo',
        permissionMode: 'plan',
      });

      expect(args).toContain('--permission-mode');
      expect(args).toContain('plan');
    });

    it('includes append-system-prompt when specified', () => {
      const args = buildCliArgs({
        prompt: 'test',
        model: 'claude-sonnet-4-6',
        cwd: '/repo',
        appendSystemPrompt: 'You are helpful',
      });

      expect(args).toContain('--append-system-prompt');
      expect(args).toContain('You are helpful');
    });

    it('includes resume flag with session id', () => {
      const args = buildCliArgs({
        prompt: 'test',
        model: 'claude-sonnet-4-6',
        cwd: '/repo',
        sessionId: 'session-123',
      });

      expect(args).toContain('--resume');
      expect(args).toContain('session-123');
    });

    it('includes --fork-session after --resume when forkSession is true and sessionId is set', () => {
      const args = buildCliArgs({
        prompt: 'test',
        model: 'claude-sonnet-4-6',
        cwd: '/repo',
        sessionId: 'session-123',
        forkSession: true,
      });

      expect(args).toContain('--resume');
      expect(args).toContain('session-123');
      expect(args).toContain('--fork-session');
      const resumeIdx = args.indexOf('--resume');
      const forkIdx = args.indexOf('--fork-session');
      expect(forkIdx).toBeGreaterThan(resumeIdx);
    });

    it('omits --fork-session when forkSession is true but sessionId is absent', () => {
      const args = buildCliArgs({
        prompt: 'test',
        model: 'claude-sonnet-4-6',
        cwd: '/repo',
        forkSession: true,
      });

      expect(args).not.toContain('--fork-session');
    });

    it('omits --fork-session when forkSession is undefined and sessionId is set', () => {
      const args = buildCliArgs({
        prompt: 'test',
        model: 'claude-sonnet-4-6',
        cwd: '/repo',
        sessionId: 'session-123',
      });

      expect(args).not.toContain('--fork-session');
    });

    it('includes allowedTools when tools are specified', () => {
      const args = buildCliArgs({
        prompt: 'test',
        model: 'claude-sonnet-4-6',
        cwd: '/repo',
        tools: ['Read', 'Glob', 'Grep'],
      });

      expect(args).toContain('--allowedTools');
      expect(args).toContain('Read,Glob,Grep');
    });

    it('omits allowedTools when tools array is empty', () => {
      const args = buildCliArgs({
        prompt: 'test',
        model: 'claude-sonnet-4-6',
        cwd: '/repo',
        tools: [],
      });

      expect(args).not.toContain('--allowedTools');
    });

    it('includes add-dir entries', () => {
      const args = buildCliArgs({
        prompt: 'test',
        model: 'claude-sonnet-4-6',
        cwd: '/repo',
        addDirs: ['/sibling-a', '/sibling-b'],
      });

      const addDirIndices = args.reduce<number[]>((indices, arg, i) => {
        if (arg === '--add-dir') indices.push(i);
        return indices;
      }, []);
      expect(addDirIndices).toHaveLength(2);
      expect(args[addDirIndices[0] + 1]).toBe('/sibling-a');
      expect(args[addDirIndices[1] + 1]).toBe('/sibling-b');
    });

    it('includes --json-schema when jsonSchema is provided', () => {
      const schema = '{"type":"object","properties":{"action":{"type":"string"}}}';
      const args = buildCliArgs({
        prompt: 'test',
        model: 'claude-sonnet-4-6',
        cwd: '/repo',
        jsonSchema: schema,
      });

      const idx = args.indexOf('--json-schema');
      expect(idx).toBeGreaterThan(-1);
      expect(args[idx + 1]).toBe(schema);
    });

    it('omits --json-schema when jsonSchema is not provided', () => {
      const args = buildCliArgs({
        prompt: 'test',
        model: 'claude-sonnet-4-6',
        cwd: '/repo',
      });

      expect(args).not.toContain('--json-schema');
    });

    it('omits --append-system-prompt when appendSystemPrompt is undefined', () => {
      const args = buildCliArgs({
        prompt: 'test',
        model: 'claude-sonnet-4-6',
        cwd: '/repo',
        appendSystemPrompt: undefined,
      });
      expect(args).not.toContain('--append-system-prompt');
    });

    it('adds --image flag for each screenshot path', () => {
      const args = buildCliArgs({
        prompt: 'test',
        model: 'claude-sonnet-4-6',
        cwd: '/repo',
        screenshots: [
          { path: '/tmp/a.png', mediaType: 'image/png', base64: 'x' },
          { path: '/tmp/b.jpg', mediaType: 'image/jpeg', base64: 'y' },
        ],
      });

      const imageFlags = args.reduce<string[]>((acc, arg, idx, arr) => {
        if (arg === '--image') acc.push(arr[idx + 1]);
        return acc;
      }, []);
      expect(imageFlags).toEqual(['/tmp/a.png', '/tmp/b.jpg']);
    });

    it('omits --image when screenshots array is empty', () => {
      const args = buildCliArgs({
        prompt: 'test',
        model: 'claude-sonnet-4-6',
        cwd: '/repo',
        screenshots: [],
      });
      expect(args).not.toContain('--image');
    });

    it('omits --image when screenshots is undefined', () => {
      const args = buildCliArgs({
        prompt: 'test',
        model: 'claude-sonnet-4-6',
        cwd: '/repo',
      });
      expect(args).not.toContain('--image');
    });
  });

  describe('parseNdjsonLine', () => {
    it('parses a valid JSON line', () => {
      const result = parseNdjsonLine('{"type":"result","result":"hello","session_id":"s1"}');
      expect(result).toEqual({
        type: 'result',
        result: 'hello',
        session_id: 's1',
      });
    });

    it('returns null for empty lines', () => {
      expect(parseNdjsonLine('')).toBeNull();
      expect(parseNdjsonLine('   ')).toBeNull();
    });

    it('returns null for invalid JSON', () => {
      expect(parseNdjsonLine('not json')).toBeNull();
    });

    it('trims whitespace before parsing', () => {
      const result = parseNdjsonLine('  {"type":"test"}  ');
      expect(result).toEqual({ type: 'test' });
    });
  });

  describe('isSystemChatter', () => {
    afterEach(() => {
      jest.restoreAllMocks();
    });

    it('returns true for rate_limit_event', () => {
      expect(isSystemChatter({ type: 'rate_limit_event' } as ClaudeCliMessage)).toBe(true);
    });

    it('returns true for system/status', () => {
      expect(isSystemChatter({ type: 'system', subtype: 'status' } as ClaudeCliMessage)).toBe(true);
    });

    it('returns true for system/compact_boundary', () => {
      expect(isSystemChatter({ type: 'system', subtype: 'compact_boundary' } as ClaudeCliMessage)).toBe(true);
    });

    it('returns true for system/api_retry', () => {
      expect(isSystemChatter({ type: 'system', subtype: 'api_retry' } as ClaudeCliMessage)).toBe(true);
    });

    it('returns false for system/init (meaningful progress)', () => {
      expect(isSystemChatter({ type: 'system', subtype: 'init' } as ClaudeCliMessage)).toBe(false);
    });

    it('returns false for assistant messages', () => {
      expect(isSystemChatter({ type: 'assistant' } as ClaudeCliMessage)).toBe(false);
    });

    it('returns false for result messages', () => {
      expect(isSystemChatter({ type: 'result' } as ClaudeCliMessage)).toBe(false);
    });

    it('returns false for error messages', () => {
      expect(isSystemChatter({ type: 'error' } as ClaudeCliMessage)).toBe(false);
    });

    it('returns false for unknown future message types (deny-list default)', () => {
      expect(isSystemChatter({ type: 'unknown_future_type' } as ClaudeCliMessage)).toBe(false);
    });
  });

  describe('spawnCli', () => {
    // The runner signals the child's process group. The mock child's pid is fictional, so a
    // real process.kill would signal an unrelated group on the host machine.
    let mockProcessKill: jest.SpyInstance;

    beforeEach(() => {
      mockProcessKill = jest.spyOn(process, 'kill').mockImplementation(() => true);
    });

    afterEach(() => {
      mockProcessKill.mockRestore();
    });

    it('spawns the child detached so it leads its own process group', async () => {
      const child = createMockChildProcess();
      mockSpawn.mockReturnValue(child as any);

      const gen = spawnCli(['-p'], '/repo', 'test', undefined, 5000);
      child.stdout.push(null);
      for await (const _msg of gen) {
        // drain
      }

      expect(mockSpawn).toHaveBeenCalledWith(
        'claude',
        expect.any(Array),
        expect.objectContaining({ detached: true })
      );
    });

    it('kills the whole process group so verification subprocesses cannot outlive the run', async () => {
      const child = createMockChildProcess();
      mockSpawn.mockReturnValue(child as any);

      const gen = spawnCli(['-p'], '/repo', 'test', undefined, 100);
      child.stdout.push('{"type":"system","subtype":"init"}\n');
      for await (const _msg of gen) {
        // drain until the wall-clock kill fires
      }

      expect(mockProcessKill).toHaveBeenCalledWith(-child.pid, 'SIGTERM');
    });

    it('yields a timeout error message when the subprocess exceeds the timeout', async () => {
      const child = createMockChildProcess();
      mockSpawn.mockReturnValue(child as any);

      const messages: Array<{
        type: string;
        is_error?: boolean;
        result?: string;
        subtype?: string;
      }> = [];
      const gen = spawnCli(['-p'], '/repo', 'test', undefined, 100);

      // Push an init message so yieldedAny becomes true, then let the timeout fire
      child.stdout.push('{"type":"system","subtype":"init"}\n');

      for await (const msg of gen) {
        messages.push(msg);
      }

      const timeoutMsg = messages.find(m => m.type === 'error' && m.subtype === 'timeout');
      if (!timeoutMsg) throw new Error('expected timeoutMsg');
      expect(timeoutMsg.is_error).toBe(true);
      expect(timeoutMsg.result).toMatch(/wall-clock limit/i);
    });

    it('yields parsed NDJSON messages from stdout', async () => {
      const child = createMockChildProcess();
      mockSpawn.mockReturnValue(child as any);

      const gen = spawnCli(['-p'], '/repo', 'test', undefined, 5000);

      // Push messages then close stdout
      child.stdout.push('{"type":"assistant","result":"hello"}\n');
      child.stdout.push('{"type":"result","result":"done"}\n');
      child.stdout.push(null);

      const messages: Array<{ type: string; result?: string }> = [];
      for await (const msg of gen) {
        messages.push(msg);
      }

      expect(messages).toHaveLength(2);
      expect(messages[0]).toEqual({ type: 'assistant', result: 'hello' });
      expect(messages[1]).toEqual({ type: 'result', result: 'done' });
    });

    it('throws with stderr when no NDJSON was yielded', async () => {
      const child = createMockChildProcess();
      // Don't close stdout on kill — let it close naturally via push(null)
      child.kill = jest.fn(function (this: { killed: boolean }) {
        this.killed = true;
      }) as any;
      mockSpawn.mockReturnValue(child as any);

      const gen = spawnCli(['-p'], '/repo', 'test', undefined, 5000);

      // Schedule events after the generator starts iterating (so listeners are attached)
      setImmediate(() => {
        child.stderr.emit('data', Buffer.from('fatal error'));
        child.stdout.push(null);
      });

      const collect = async () => {
        const msgs: unknown[] = [];
        for await (const msg of gen) msgs.push(msg);
      };

      await expect(collect()).rejects.toThrow(/fatal error/);
    });

    it('resets inactivity timer on each yielded message', async () => {
      const child = createMockChildProcess();
      mockSpawn.mockReturnValue(child as any);

      // timeoutMs=0 disables wall-clock; inactivityTimeoutMs=200ms
      const gen = spawnCli(['-p'], '/repo', 'test', undefined, 0, 200);

      const messages: Array<{ type: string; subtype?: string }> = [];
      const collect = (async () => {
        for await (const msg of gen) {
          messages.push(msg);
        }
      })();

      // Push messages within the 200ms inactivity window, then close
      child.stdout.push('{"type":"system","subtype":"init"}\n');
      await new Promise(resolve => setImmediate(resolve));
      child.stdout.push('{"type":"assistant","result":"working"}\n');
      await new Promise(resolve => setImmediate(resolve));
      child.stdout.push(null);

      await collect;

      const timeoutMsg = messages.find(m => m.type === 'error' && m.subtype === 'timeout');
      expect(timeoutMsg).toBeUndefined();
      expect(messages.length).toBeGreaterThanOrEqual(2);
    });

    it('yields inactivity timeout when no messages arrive within the inactivity window', async () => {
      const child = createMockChildProcess();
      mockSpawn.mockReturnValue(child as any);

      // timeoutMs=0 disables wall-clock; inactivityTimeoutMs=50ms
      const gen = spawnCli(['-p'], '/repo', 'test', undefined, 0, 50);

      const messages: Array<{ type: string; subtype?: string; is_error?: boolean; result?: string }> = [];
      for await (const msg of gen) {
        messages.push(msg);
      }

      const timeoutMsg = messages.find(m => m.type === 'error' && m.subtype === 'timeout');
      if (!timeoutMsg) throw new Error('expected timeoutMsg');
      expect(timeoutMsg.is_error).toBe(true);
      expect(timeoutMsg.result).toMatch(/stalled/i);
      expect(timeoutMsg.result).toMatch(/no output/i);
    });

    it('fires inactivity timeout despite system chatter messages', async () => {
      const child = createMockChildProcess();
      mockSpawn.mockReturnValue(child as any);

      // timeoutMs=0 disables wall-clock; inactivityTimeoutMs=100ms
      const gen = spawnCli(['-p'], '/repo', 'test', undefined, 0, 100);

      const messages: Array<{ type: string; subtype?: string; is_error?: boolean; result?: string }> = [];
      const collectPromise = (async () => {
        for await (const msg of gen) {
          messages.push(msg);
        }
      })();

      // Push system chatter with delays — these should NOT reset inactivity
      child.stdout.push('{"type":"system","subtype":"status"}\n');
      await new Promise(resolve => setTimeout(resolve, 60));
      child.stdout.push('{"type":"rate_limit_event"}\n');
      await new Promise(resolve => setTimeout(resolve, 60));
      child.stdout.push('{"type":"system","subtype":"compact_boundary"}\n');
      // Don't close — let inactivity timer fire

      await collectPromise;

      const timeoutMsg = messages.find(m => m.type === 'error' && m.subtype === 'timeout');
      if (!timeoutMsg) throw new Error('expected timeoutMsg');
      expect(timeoutMsg.is_error).toBe(true);
      expect(timeoutMsg.result).toMatch(/stalled/i);
    });
  });

  describe('SIGINT handling', () => {
    afterEach(() => {
      jest.restoreAllMocks();
      mockSpawn.mockReset();
    });

    it('registers a SIGINT listener when the generator starts and removes it after completion', async () => {
      const child = createMockChildProcess();
      mockSpawn.mockReturnValue(child as any);

      const listenersBefore = process.listenerCount('SIGINT');

      const gen = spawnCli(['-p'], '/repo', 'hello');

      // Push one message then end stream to complete naturally
      const tickPromise = (async () => {
        await new Promise(resolve => setImmediate(resolve));
        child.stdout.push(JSON.stringify({ type: 'result', subtype: 'success', result: 'done' }) + '\n');
        await new Promise(resolve => setImmediate(resolve));
        child.stdout.push(null);
      })();

      const messages: unknown[] = [];
      for await (const msg of gen) {
        messages.push(msg);
      }

      await tickPromise;

      const listenersAfter = process.listenerCount('SIGINT');
      expect(listenersAfter).toBe(listenersBefore);
    });

    it('kills child process when SIGINT fires during stream', async () => {
      const child = createMockChildProcess();
      mockSpawn.mockReturnValue(child as any);

      const gen = spawnCli(['-p'], '/repo', 'hello');

      // Start consuming without ending — emit SIGINT
      const consumePromise = (async () => {
        for await (const _msg of gen) {
          break;
        }
      })();

      await new Promise(resolve => setImmediate(resolve));
      process.emit('SIGINT', 'SIGINT');

      await consumePromise;

      expect(child.kill).toHaveBeenCalled();
    });
  });

  describe('spawnCli diagnostics', () => {
    let appendSpy: jest.SpyInstance;

    const linesFor = (prefix: string): string[] =>
      appendSpy.mock.calls.map(call => String(call[1])).filter(line => line.startsWith(prefix));

    const drain = async (gen: AsyncGenerator<ClaudeCliMessage, void, undefined>): Promise<ClaudeCliMessage[]> => {
      const messages: ClaudeCliMessage[] = [];
      for await (const msg of gen) messages.push(msg);
      return messages;
    };

    /**
     * Yields to the event loop so the generator body runs. An async generator is lazy:
     * until the first `next()`, no child listeners are attached, so events emitted
     * before this resolves are lost (stderr) or thrown as unhandled ('error').
     */
    const started = (): Promise<void> => new Promise(resolve => setImmediate(resolve));

    beforeEach(() => {
      appendSpy = jest.spyOn(logFileWriter, 'appendToLogFile').mockImplementation(() => undefined);
    });

    afterEach(() => jest.restoreAllMocks());

    it('records the model, resolved timeouts, and cwd on spawn', async () => {
      const child = createMockChildProcess();
      mockSpawn.mockReturnValue(child as any);

      const gen = spawnCli(
        ['-p', '--model', 'claude-opus-5', '--append-system-prompt', 'x'.repeat(12043)],
        '/repo',
        'prompt',
        undefined,
        1800000,
        120000
      );
      child.stdout.push(null);
      await drain(gen);

      const [spawnLine] = linesFor('cli.spawn ');
      expect(spawnLine).toContain('model=claude-opus-5');
      expect(spawnLine).toContain('inactivityTimeoutMs=120000');
      expect(spawnLine).toContain('cwd=/repo');
      expect(spawnLine).toContain('<12043 chars>');
    });

    it('records an inactivity kill and still yields the stall message', async () => {
      const child = createMockChildProcess();
      mockSpawn.mockReturnValue(child as any);

      const gen = spawnCli(['-p'], '/repo', 'prompt', undefined, 60000, 50);
      child.stdout.push('{"type":"system","subtype":"init"}\n');
      const messages = await drain(gen);

      expect(linesFor('cli.kill ')[0]).toContain('reason=inactivity');
      const timeoutMsg = messages.find(m => m.subtype === 'timeout');
      expect(timeoutMsg?.result).toMatch(/stalled/i);
      expect(timeoutMsg?.result).toMatch(/inactivityTimeoutMs/);
    });

    it('records a wall-clock kill distinctly from an inactivity kill', async () => {
      const child = createMockChildProcess();
      mockSpawn.mockReturnValue(child as any);

      const gen = spawnCli(['-p'], '/repo', 'prompt', undefined, 50, 60000);
      child.stdout.push('{"type":"system","subtype":"init"}\n');
      const messages = await drain(gen);

      expect(linesFor('cli.kill ')[0]).toContain('reason=wall-clock');
      expect(messages.find(m => m.subtype === 'timeout')?.result).toMatch(/wall-clock/i);
    });

    it('records only the first kill reason when both timers are armed', async () => {
      const child = createMockChildProcess();
      mockSpawn.mockReturnValue(child as any);

      const gen = spawnCli(['-p'], '/repo', 'prompt', undefined, 60000, 50);
      child.stdout.push('{"type":"system","subtype":"init"}\n');
      await drain(gen);

      const killLines = linesFor('cli.kill ');
      expect(killLines).toHaveLength(1);
      expect(killLines[0]).toContain('reason=inactivity');
    });

    it('records a clean exit at DEBUG and a signalled exit at WARN', async () => {
      const child = createMockChildProcess();
      mockSpawn.mockReturnValue(child as any);

      const gen = spawnCli(['-p'], '/repo', 'prompt', undefined, 5000);
      child.stdout.push(null);
      await drain(gen);
      child.emit('exit', 0, null);

      const cleanCall = appendSpy.mock.calls.find(call => String(call[1]).startsWith('cli.exit '));
      expect(cleanCall?.[0]).toBe('DEBUG');
      expect(cleanCall?.[1]).toContain('code=0');

      // cli.done must also be DEBUG on a clean run with no stderr — cleanup is not a problem signal
      const doneCall = appendSpy.mock.calls.find(call => String(call[1]).startsWith('cli.done '));
      expect(doneCall?.[0]).toBe('DEBUG');
    });

    it('records a signalled exit at WARN', async () => {
      const child = createMockChildProcess();
      mockSpawn.mockReturnValue(child as any);

      const gen = spawnCli(['-p'], '/repo', 'prompt', undefined, 5000);
      child.stdout.push(null);
      await drain(gen);
      child.emit('exit', null, 'SIGTERM');

      const signalledCall = appendSpy.mock.calls.find(call => String(call[1]).startsWith('cli.exit '));
      expect(signalledCall?.[0]).toBe('WARN');
      expect(signalledCall?.[1]).toContain('signal=SIGTERM');
    });

    it('captures stderr even when the run produced output', async () => {
      const child = createMockChildProcess();
      mockSpawn.mockReturnValue(child as any);

      const gen = spawnCli(['-p'], '/repo', 'prompt', undefined, 5000);
      const drained = drain(gen);
      await started();
      child.stderr.emit('data', Buffer.from('deprecation warning'));
      child.stdout.push('{"type":"result","result":"done"}\n');
      child.stdout.push(null);
      await drained;

      expect(linesFor('cli.done ')[0]).toContain('deprecation warning');
    });

    it('captures stderr on the timeout path', async () => {
      const child = createMockChildProcess();
      mockSpawn.mockReturnValue(child as any);

      const gen = spawnCli(['-p'], '/repo', 'prompt', undefined, 60000, 50);
      const drained = drain(gen);
      await started();
      child.stderr.emit('data', Buffer.from('stderr before the kill'));
      child.stdout.push('{"type":"system","subtype":"init"}\n');
      await drained;

      expect(linesFor('cli.done ')[0]).toContain('stderr before the kill');
    });

    it('reports a spawn failure explicitly instead of looking like a stall', async () => {
      const child = createMockChildProcess();
      mockSpawn.mockReturnValue(child as any);

      const gen = spawnCli(['-p'], '/repo', 'prompt', undefined, 5000);
      const drained = drain(gen);
      await started();
      child.emit('error', new Error('spawn claude ENOENT'));
      child.stdout.push(null);

      await expect(drained).rejects.toThrow(/Failed to spawn claude.*ENOENT/);
      expect(linesFor('cli.spawn_error ')).toHaveLength(1);
    });

    it('does not throw for a spawn error once messages were produced', async () => {
      const child = createMockChildProcess();
      mockSpawn.mockReturnValue(child as any);

      const gen = spawnCli(['-p'], '/repo', 'prompt', undefined, 5000);
      const drained = drain(gen);
      await started();
      child.stdout.push('{"type":"result","result":"done"}\n');
      child.emit('error', new Error('spawn claude ENOENT'));
      child.stdout.push(null);

      await expect(drained).resolves.toHaveLength(1);
    });

    it('records the run summary when the consumer breaks early', async () => {
      const child = createMockChildProcess();
      mockSpawn.mockReturnValue(child as any);

      const gen = spawnCli(['-p'], '/repo', 'prompt', undefined, 5000);
      child.stdout.push('{"type":"assistant","result":"hi"}\n');

      for await (const _msg of gen) break;

      expect(linesFor('cli.done ')).toHaveLength(1);
    });

    it('records a sigint kill and yields no timeout message', async () => {
      const child = createMockChildProcess();
      mockSpawn.mockReturnValue(child as any);

      const gen = spawnCli(['-p'], '/repo', 'prompt', undefined, 60000, 60000);
      child.stdout.push('{"type":"assistant","result":"hi"}\n');

      const messages: ClaudeCliMessage[] = [];
      const consumePromise = (async () => {
        for await (const msg of gen) messages.push(msg);
      })();

      await new Promise(resolve => setImmediate(resolve));
      process.emit('SIGINT', 'SIGINT');
      await consumePromise;

      expect(linesFor('cli.kill ')[0]).toContain('reason=sigint');
      expect(messages.find(m => m.subtype === 'timeout')).toBeUndefined();
    });
  });
});
