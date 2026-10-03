import { executeWithCatch, executeAsyncWithCatch } from './execute-with-catch';
import { ErrorHandler } from './error-handler';

jest.mock('./error-handler', () => ({
  ErrorHandler: { handle: jest.fn() },
}));

const mockHandle = ErrorHandler.handle as jest.MockedFunction<typeof ErrorHandler.handle>;

beforeEach(() => {
  jest.clearAllMocks();
});

describe('executeWithCatch', () => {
  describe('rethrowIf', () => {
    it('propagates the original error instance when rethrowIf returns true', () => {
      const thrown = new Error('selective');
      let caught: unknown;
      try {
        executeWithCatch({
          fn: () => { throw thrown; },
          rethrowIf: () => true,
        });
      } catch (e) {
        caught = e;
      }
      expect(caught).toBe(thrown);
    });

    it('does not call onError when rethrowIf returns true', () => {
      const onError = jest.fn();
      let caughtError: unknown;
      try {
        executeWithCatch({
          fn: () => { throw new Error(); },
          rethrowIf: () => true,
          onError,
        });
      } catch (e) {
        caughtError = e;
      }
      expect(caughtError).toBeInstanceOf(Error);
      expect(onError).not.toHaveBeenCalled();
    });

    it('does not call ErrorHandler.handle when rethrowIf returns true', () => {
      let caughtError: unknown;
      try {
        executeWithCatch({
          fn: () => { throw new Error(); },
          rethrowIf: () => true,
        });
      } catch (e) {
        caughtError = e;
      }
      expect(caughtError).toBeInstanceOf(Error);
      expect(mockHandle).not.toHaveBeenCalled();
    });

    it('falls through to onError when rethrowIf returns false', () => {
      const [, fallback] = executeWithCatch({
        fn: () => { throw new Error(); },
        rethrowIf: () => false,
        onError: () => 'caught',
      });
      expect(fallback).toBe('caught');
    });

    it('falls through to ErrorHandler.handle when rethrowIf returns false and no onError', () => {
      executeWithCatch({
        fn: () => { throw new Error(); },
        rethrowIf: () => false,
      });
      expect(mockHandle).toHaveBeenCalled();
    });
  });

  it('returns [result, undefined] on success', () => {
    const [result, fallback] = executeWithCatch({ fn: () => 42 });

    expect(result).toBe(42);
    expect(fallback).toBeUndefined();
  });

  it('returns [undefined, fallback] when onError is provided', () => {
    const [result, fallback] = executeWithCatch({
      fn: () => {
        throw new Error('boom');
      },
      onError: () => 'recovered',
    });

    expect(result).toBeUndefined();
    expect(fallback).toBe('recovered');
  });

  it('passes the thrown error to onError', () => {
    const thrown = new Error('specific');
    const onError = jest.fn(() => 'handled');

    executeWithCatch({
      fn: () => {
        throw thrown;
      },
      onError,
    });

    expect(onError).toHaveBeenCalledWith(thrown);
  });

  it('delegates to ErrorHandler.handle when no onError is provided', () => {
    const thrown = new Error('unhandled');

    executeWithCatch({
      fn: () => {
        throw thrown;
      },
    });

    expect(mockHandle).toHaveBeenCalledWith(thrown);
  });

  it('returns void result as undefined in the result slot', () => {
    const [result] = executeWithCatch({ fn: () => {} });

    expect(result).toBeUndefined();
  });
});

describe('executeAsyncWithCatch', () => {
  describe('rethrowIf', () => {
    it('propagates the original error instance when rethrowIf returns true', async () => {
      const thrown = new Error('async selective');
      await expect(
        executeAsyncWithCatch({
          fn: async () => { throw thrown; },
          rethrowIf: () => true,
        })
      ).rejects.toBe(thrown);
    });

    it('does not call onError when rethrowIf returns true', async () => {
      const onError = jest.fn();
      await expect(
        executeAsyncWithCatch({
          fn: async () => { throw new Error(); },
          rethrowIf: () => true,
          onError,
        })
      ).rejects.toThrow();
      expect(onError).not.toHaveBeenCalled();
    });

    it('does not call ErrorHandler.handle when rethrowIf returns true', async () => {
      let caughtError: unknown;
      try {
        await executeAsyncWithCatch({
          fn: async () => {
            throw new Error();
          },
          rethrowIf: () => true,
        });
      } catch (e) {
        caughtError = e;
      }
      expect(caughtError).toBeInstanceOf(Error);
      expect(mockHandle).not.toHaveBeenCalled();
    });
  });

  it('returns [result, undefined] on success', async () => {
    const [result, fallback] = await executeAsyncWithCatch({ fn: async () => 'ok' });

    expect(result).toBe('ok');
    expect(fallback).toBeUndefined();
  });

  it('returns [undefined, fallback] when onError is provided', async () => {
    const [result, fallback] = await executeAsyncWithCatch({
      fn: async () => {
        throw new Error('async boom');
      },
      onError: () => 'async recovered',
    });

    expect(result).toBeUndefined();
    expect(fallback).toBe('async recovered');
  });

  it('supports async onError handlers', async () => {
    const [, fallback] = await executeAsyncWithCatch({
      fn: async () => {
        throw new Error('fail');
      },
      onError: async () => 'async fallback',
    });

    expect(fallback).toBe('async fallback');
  });

  it('delegates to ErrorHandler.handle when no onError is provided', async () => {
    const thrown = new Error('unhandled async');

    await executeAsyncWithCatch({
      fn: async () => {
        throw thrown;
      },
    });

    expect(mockHandle).toHaveBeenCalledWith(thrown);
  });
});
