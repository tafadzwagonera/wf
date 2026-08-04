import { AIError, GitError } from '../errors/app.error';
import { ErrorHandler } from './error-handler';

describe('ErrorHandler', () => {
  let exitSpy: jest.SpyInstance;
  let consoleSpy: jest.SpyInstance;

  beforeEach(() => {
    exitSpy = jest.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => jest.restoreAllMocks());

  const allOutput = (): string =>
    consoleSpy.mock.calls.map((args: unknown[]) => String(args[0])).join('\n');

  describe('getSuggestion — category-aware suggestions', () => {
    it('returns parse suggestion for parse category', () => {
      ErrorHandler.handle(new AIError('msg', null, true, 'parse'));
      expect(allOutput()).toContain('could not be parsed');
      expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it('returns truncation suggestion for truncation category', () => {
      ErrorHandler.handle(new AIError('msg', null, true, 'truncation'));
      expect(allOutput()).toContain('Reduce prompt/context size');
      expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it('returns stall suggestion for stall category', () => {
      ErrorHandler.handle(new AIError('msg', null, true, 'stall'));
      expect(allOutput()).toContain('stalled');
      expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it('returns default AI suggestion when category is undefined', () => {
      ErrorHandler.handle(new AIError('msg'));
      expect(allOutput()).toContain('API keys');
      expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it('returns default AI suggestion when category is auth', () => {
      ErrorHandler.handle(new AIError('msg', null, true, 'auth'));
      expect(allOutput()).toContain('API keys');
      expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it('returns default AI suggestion when category is api', () => {
      ErrorHandler.handle(new AIError('msg', null, true, 'api'));
      expect(allOutput()).toContain('API keys');
      expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it('returns git suggestion for GitError', () => {
      ErrorHandler.handle(new GitError('msg'));
      expect(allOutput()).toContain('git repository');
      expect(exitSpy).toHaveBeenCalledWith(1);
    });
  });

  describe('sanitizeDetailsForDisplay — response truncation', () => {
    it('truncates response strings longer than 200 chars', () => {
      const longResponse = 'x'.repeat(300);
      ErrorHandler.handle(new AIError('msg', { response: longResponse }, true, 'parse'));
      expect(allOutput()).toContain('[truncated, 300 chars total]');
      expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it('does not truncate response strings of 200 chars or fewer', () => {
      const shortResponse = 'x'.repeat(200);
      ErrorHandler.handle(new AIError('msg', { response: shortResponse }, true, 'parse'));
      expect(allOutput()).not.toContain('[truncated');
      expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it('replaces nested Error objects with their message string', () => {
      const innerError = new Error('inner error message');
      ErrorHandler.handle(new AIError('msg', { error: innerError }, true, 'parse'));
      const output = allOutput();
      expect(output).toContain('inner error message');
      expect(output).not.toContain('[object Object]');
      expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it('passes through details without response or error keys unchanged', () => {
      ErrorHandler.handle(new AIError('msg', { someKey: 'someValue' }, true, 'parse'));
      expect(allOutput()).toContain('someValue');
      expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it('omits Details section for null details', () => {
      ErrorHandler.handle(new AIError('msg', null, true, 'parse'));
      expect(allOutput()).not.toContain('Details:');
      expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it('passes through primitive string details unchanged', () => {
      ErrorHandler.handle(new AIError('msg', 'raw string' as unknown, true, 'parse'));
      expect(allOutput()).toContain('raw string');
      expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it('does not mutate original error.details', () => {
      const details = { response: 'x'.repeat(300), extra: 'preserved' };
      const error = new AIError('msg', details, true, 'parse');
      ErrorHandler.handle(error);
      expect(error.details.response).toHaveLength(300);
      expect(error.details.extra).toBe('preserved');
      expect(exitSpy).toHaveBeenCalledWith(1);
    });
  });
});
