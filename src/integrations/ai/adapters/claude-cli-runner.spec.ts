import {
  assertClaudeCliAvailable,
  buildCliArgs,
  parseClaudeCliVersion,
  parseNdjsonLine,
  spawnCli,
} from './claude-cli-runner';
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
        .mockReturnValueOnce('2.1.80 (Claude Code)' as any);
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

  describe('spawnCli', () => {
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
});
