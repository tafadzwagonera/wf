import { ErrorHandler } from './error-handler';

interface ExecuteWithCatchOpts<R, S> {
  fn: () => R;
  onError?: (error: unknown) => S;
  rethrowIf?: (error: unknown) => boolean;
}

interface ExecuteAsyncWithCatchOpts<R, S> {
  fn: () => Promise<R>;
  onError?: (error: unknown) => S | Promise<S>;
  rethrowIf?: (error: unknown) => boolean;
}

/**
 * Execute a synchronous callback and return its result paired with an
 * error slot.  When the callback throws and no `onError` handler is
 * provided, the error is forwarded to `ErrorHandler.handle` which
 * terminates the process with a formatted diagnostic.
 * When `rethrowIf` is provided and returns true for the thrown error,
 * the original error is rethrown unchanged before `onError` or `ErrorHandler` are consulted.
 *
 * @returns `[result, undefined]` on success, `[undefined, error]` on handled error
 */
export const executeWithCatch = <R = void, S = undefined>(
  opts: ExecuteWithCatchOpts<R, S>
): [R, undefined] | [undefined, S] => {
  try {
    const result = opts.fn();
    return [result, undefined];
  } catch (error: unknown) {
    if (opts.rethrowIf?.(error)) throw error;
    if (opts.onError) {
      const handled = opts.onError(error);
      return [undefined, handled];
    }
    return ErrorHandler.handle(error as Error);
  }
};

/**
 * Execute an asynchronous callback and return its result paired with an
 * error slot.  When the callback throws and no `onError` handler is
 * provided, the error is forwarded to `ErrorHandler.handle` which
 * terminates the process with a formatted diagnostic.
 * When `rethrowIf` is provided and returns true for the thrown error,
 * the original error is rethrown unchanged before `onError` or `ErrorHandler` are consulted.
 *
 * @returns `[result, undefined]` on success, `[undefined, error]` on handled error
 */
export const executeAsyncWithCatch = async <R = void, S = undefined>(
  opts: ExecuteAsyncWithCatchOpts<R, S>
): Promise<[R, undefined] | [undefined, S]> => {
  try {
    const result = await opts.fn();
    return [result, undefined];
  } catch (error: unknown) {
    if (opts.rethrowIf?.(error)) throw error;
    if (opts.onError) {
      const handled = await opts.onError(error);
      return [undefined, handled];
    }
    return ErrorHandler.handle(error as Error);
  }
};
