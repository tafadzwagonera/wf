import * as logFileWriter from '../../../shared/logger/log-file-writer';
import { createBoundedStderr } from '../../../shared/utils/bounded-stderr';
import {
  extractArgValue,
  formatStderrTail,
  logCliExit,
  logCliKill,
  logCliRunSummary,
  logCliSigkillEscalation,
  logCliSpawn,
  logCliSpawnError,
  summarizeCliArgs,
} from './cli-run-logger';

const mockStderrWith = (text: string) => {
  const stderr = createBoundedStderr();
  stderr.append(Buffer.from(text));
  return stderr;
};

describe('cli-run-logger', () => {
  afterEach(() => jest.restoreAllMocks());

  describe('summarizeCliArgs', () => {
    it('renders the value after --append-system-prompt as <N chars>', () => {
      const summary = summarizeCliArgs(['--append-system-prompt', 'x'.repeat(12043)]);
      expect(summary).toContain('--append-system-prompt <12043 chars>');
    });

    it('renders the value after --json-schema as <N chars>', () => {
      const summary = summarizeCliArgs(['--json-schema', 'x'.repeat(3187)]);
      expect(summary).toContain('--json-schema <3187 chars>');
    });

    it('truncates any other value over 200 chars to the first 200 plus an overflow marker', () => {
      const longValue = 'a'.repeat(250);
      const summary = summarizeCliArgs(['--some-flag', longValue]);
      expect(summary).toContain(`--some-flag ${'a'.repeat(200)}…[+50]`);
    });

    it('redacts a value whose preceding flag looks key/token/secret/password/auth-shaped', () => {
      const summary = summarizeCliArgs(['--api-key', 'sk-live-xyz']);
      expect(summary).toContain('--api-key <redacted>');
      expect(summary).not.toContain('sk-live-xyz');
    });

    it('tolerates a trailing flag with no following value', () => {
      expect(() => summarizeCliArgs(['-p', '--verbose'])).not.toThrow();
      expect(summarizeCliArgs(['-p', '--verbose'])).toBe('-p --verbose');
    });

    it('renders short, non-sensitive values verbatim', () => {
      expect(summarizeCliArgs(['--model', 'claude-opus-5'])).toBe('--model claude-opus-5');
    });
  });

  describe('extractArgValue', () => {
    it('returns the value following the given flag', () => {
      expect(extractArgValue(['--model', 'claude-opus-5'], '--model')).toBe('claude-opus-5');
    });

    it('returns undefined when the flag is absent', () => {
      expect(extractArgValue(['-p', '--verbose'], '--model')).toBeUndefined();
    });

    it('returns undefined when the flag is the last element', () => {
      expect(extractArgValue(['-p', '--model'], '--model')).toBeUndefined();
    });
  });

  describe('formatStderrTail', () => {
    it('returns the tail (not the head) once chunks exceed the cap', () => {
      const tail = formatStderrTail(`${'a'.repeat(300)}${'b'.repeat(300)}`, 100);
      expect(tail).toBe('b'.repeat(100));
    });

    it('returns the full content when under the cap', () => {
      expect(formatStderrTail('short error', 100)).toBe('short error');
    });
  });

  describe('level selection', () => {
    it('logs cli.spawn at DEBUG', () => {
      const spy = jest.spyOn(logFileWriter, 'appendToLogFile').mockImplementation(() => undefined);
      logCliSpawn({
        runId: 'abc12345',
        binary: 'claude',
        model: 'claude-opus-5',
        cwd: '/repo',
        args: ['-p'],
        envKeys: [],
        promptChars: 10,
        timeoutMs: 1800000,
        inactivityTimeoutMs: 120000,
      });
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy).toHaveBeenCalledWith('DEBUG', expect.stringContaining('cli.spawn'), 'claude-cli');
    });

    it('logs a clean cli.exit (code=0, signal=null) at DEBUG', () => {
      const spy = jest.spyOn(logFileWriter, 'appendToLogFile').mockImplementation(() => undefined);
      logCliExit({ runId: 'abc12345', exitRecord: { exited: true, code: 0, signal: null }, elapsedMs: 100 });
      expect(spy).toHaveBeenCalledWith('DEBUG', expect.stringContaining('cli.exit'), 'claude-cli');
    });

    it('logs a signalled cli.exit (code=null, signal=SIGTERM) at WARN', () => {
      const spy = jest.spyOn(logFileWriter, 'appendToLogFile').mockImplementation(() => undefined);
      logCliExit({
        runId: 'abc12345',
        exitRecord: { exited: true, code: null, signal: 'SIGTERM' },
        elapsedMs: 100,
      });
      expect(spy).toHaveBeenCalledWith('WARN', expect.stringContaining('cli.exit'), 'claude-cli');
    });

    it('logs a non-zero cli.exit at WARN', () => {
      const spy = jest.spyOn(logFileWriter, 'appendToLogFile').mockImplementation(() => undefined);
      logCliExit({ runId: 'abc12345', exitRecord: { exited: true, code: 1, signal: null }, elapsedMs: 100 });
      expect(spy).toHaveBeenCalledWith('WARN', expect.stringContaining('cli.exit'), 'claude-cli');
    });

    it('logs cli.kill at WARN', () => {
      const spy = jest.spyOn(logFileWriter, 'appendToLogFile').mockImplementation(() => undefined);
      logCliKill({
        runId: 'abc12345',
        reason: 'inactivity',
        elapsedMs: 120041,
        inactivityTimeoutMs: 120000,
        timeoutMs: 1800000,
      });
      expect(spy).toHaveBeenCalledWith('WARN', expect.stringContaining('cli.kill'), 'claude-cli');
      expect(spy).toHaveBeenCalledWith('WARN', expect.stringContaining('reason=inactivity'), 'claude-cli');
    });

    it('logs cli.sigkill at WARN', () => {
      const spy = jest.spyOn(logFileWriter, 'appendToLogFile').mockImplementation(() => undefined);
      logCliSigkillEscalation({ runId: 'abc12345', reason: 'inactivity' });
      expect(spy).toHaveBeenCalledWith('WARN', expect.stringContaining('cli.sigkill'), 'claude-cli');
    });

    it('logs cli.spawn_error at ERROR', () => {
      const spy = jest.spyOn(logFileWriter, 'appendToLogFile').mockImplementation(() => undefined);
      logCliSpawnError({ runId: 'abc12345', error: new Error('ENOENT') });
      expect(spy).toHaveBeenCalledWith('ERROR', expect.stringContaining('cli.spawn_error'), 'claude-cli');
    });

    it('logs a clean cli.done (no kill reason, no stderr) at DEBUG', () => {
      const spy = jest.spyOn(logFileWriter, 'appendToLogFile').mockImplementation(() => undefined);
      logCliRunSummary({
        runId: 'abc12345',
        messageCount: 37,
        elapsedMs: 120210,
        killReason: undefined,
        stderr: createBoundedStderr(),
      });
      expect(spy).toHaveBeenCalledWith('DEBUG', expect.stringContaining('cli.done'), 'claude-cli');
    });

    it('logs cli.done with a kill reason at WARN', () => {
      const spy = jest.spyOn(logFileWriter, 'appendToLogFile').mockImplementation(() => undefined);
      logCliRunSummary({
        runId: 'abc12345',
        messageCount: 37,
        elapsedMs: 120210,
        killReason: 'inactivity',
        stderr: createBoundedStderr(),
      });
      expect(spy).toHaveBeenCalledWith('WARN', expect.stringContaining('cli.done'), 'claude-cli');
    });

    it('logs cli.done with non-empty stderr at WARN', () => {
      const spy = jest.spyOn(logFileWriter, 'appendToLogFile').mockImplementation(() => undefined);
      logCliRunSummary({
        runId: 'abc12345',
        messageCount: 5,
        elapsedMs: 500,
        killReason: undefined,
        stderr: mockStderrWith('oops'),
      });
      expect(spy).toHaveBeenCalledWith('WARN', expect.stringContaining('cli.done'), 'claude-cli');
    });
  });

  describe('redaction guard', () => {
    it('never leaks an env value, only key names, and calls appendToLogFile exactly once', () => {
      const spy = jest.spyOn(logFileWriter, 'appendToLogFile').mockImplementation(() => undefined);
      logCliSpawn({
        runId: 'abc12345',
        binary: 'claude',
        model: 'claude-opus-5',
        cwd: '/repo',
        args: ['-p'],
        envKeys: Object.keys({ ANTHROPIC_API_KEY: 'sk-live-xyz' }).sort(),
        promptChars: 10,
        timeoutMs: 1800000,
        inactivityTimeoutMs: 120000,
      });
      expect(spy).toHaveBeenCalledTimes(1);
      const [, line] = spy.mock.calls[0];
      expect(line).toContain('ANTHROPIC_API_KEY');
      expect(line).not.toContain('sk-live-xyz');
    });
  });
});
