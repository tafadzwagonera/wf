import { ExecutionError } from '../errors/app.error';

const TRANSIENT_PATTERNS = [
  'Premature close',
  'ECONNRESET',
  'socket hang up',
  'ETIMEDOUT',
  'ECONNREFUSED',
  'fetch failed',
] as const;

/**
 * Check whether an error matches a known transient network failure pattern.
 * @param error - The caught error
 * @returns `true` when the error message contains a recognised transient pattern
 */
export const isTransientNetworkError = (error: unknown): boolean => {
  const message = error instanceof Error ? error.message : String(error);
  return TRANSIENT_PATTERNS.some(pattern => message.includes(pattern));
};

export interface RetryOnTransientOptions {
  /** Maximum number of attempts (including the first). Defaults to `2`. */
  maxAttempts?: number;
  /** Delay between retries in milliseconds. Defaults to `1000`. */
  delayInMs?: number;
  /** Called before each retry with the transient error and 1-based attempt number. */
  onRetry?: (error: unknown, attempt: number) => void;
}

const sleep = (delayInMs: number): Promise<void> => new Promise(resolve => setTimeout(resolve, delayInMs));

const runAttempt = async <T>(
  fn: () => Promise<T>,
  attempt: number,
  opts: Required<RetryOnTransientOptions>,
): Promise<T> => {
  if (attempt > opts.maxAttempts) throw new ExecutionError(`retryOnTransient: exhausted ${opts.maxAttempts} attempt(s)`);
  try {
    return await fn();
  } catch (error: unknown) {
    if (!isTransientNetworkError(error) || attempt >= opts.maxAttempts) throw error;
    opts.onRetry(error, attempt);
    await sleep(opts.delayInMs);
    return runAttempt(fn, attempt + 1, opts);
  }
};

/**
 * Execute `fn` and retry once when a transient network error is thrown.
 * Non-transient errors propagate immediately without retry.
 * @param fn - The async operation to attempt
 * @param options - Retry behaviour overrides
 * @returns The resolved value of `fn`
 */
export const retryOnTransient = <T>(fn: () => Promise<T>, options?: RetryOnTransientOptions): Promise<T> =>
  runAttempt(fn, 1, {
    maxAttempts: options?.maxAttempts ?? 2,
    delayInMs: options?.delayInMs ?? 1000,
    onRetry: options?.onRetry ?? (() => undefined),
  });
