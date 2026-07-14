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
