import {
  assertClaudeCliAvailable,
  buildCliArgs,
  parseNdjsonLine,
} from './claude-cli-runner';
import { execSync } from 'child_process';

jest.mock('child_process', () => ({
  ...jest.requireActual('child_process'),
  execSync: jest.fn(),
  spawn: jest.fn(),
}));

const mockExecSync = execSync as jest.MockedFunction<typeof execSync>;

describe('claude-cli-runner', () => {
  describe('assertClaudeCliAvailable', () => {
    it('does not throw when claude is available', () => {
      mockExecSync.mockReturnValue(Buffer.from('/usr/local/bin/claude'));
      expect(() => assertClaudeCliAvailable()).not.toThrow();
    });

    it('throws with install instructions when claude is missing', () => {
      mockExecSync.mockImplementation(() => {
        throw new Error('not found');
      });
      expect(() => assertClaudeCliAvailable()).toThrow(
        /Claude CLI is not installed/,
      );
      expect(() => assertClaudeCliAvailable()).toThrow(/docs\.anthropic\.com/);
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
  });

  describe('parseNdjsonLine', () => {
    it('parses a valid JSON line', () => {
      const result = parseNdjsonLine(
        '{"type":"result","result":"hello","session_id":"s1"}',
      );
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
});
