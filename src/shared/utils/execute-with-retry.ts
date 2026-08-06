import chalk from 'chalk';
import { AppError } from '../errors/app.error';

export const sleep = (delayInMs: number): Promise<void> =>
  new Promise(resolve => setTimeout(resolve, delayInMs));

const toRetryError = (error: unknown): Error => error instanceof Error ? error : new Error(String(error));

const shouldRetry = (attempt: number, maxRetries: number): boolean => attempt < maxRetries;

const logRetryAttempt = (attempt: number, currentDelayInMs: number): void => {
  console.log(chalk.yellow(`\n⚠️  Attempt ${attempt} failed. Retrying in ${currentDelayInMs}ms...`));
};

const processRetryFailure = async (
  error: unknown,
  attempt: number,
  maxRetries: number,
  currentDelayInMs: number
): Promise<{ currentDelayInMs: number; lastError: Error }> => {
  if (error instanceof AppError && !error.recoverable) throw error;
  const lastError = toRetryError(error);
  if (!shouldRetry(attempt, maxRetries)) return { currentDelayInMs, lastError };
  logRetryAttempt(attempt, currentDelayInMs);
  await sleep(currentDelayInMs);
  return { currentDelayInMs: currentDelayInMs * 2, lastError };
};

const tryOperation = async <T>(
  operation: () => Promise<T>,
  attempt: number,
  maxRetries: number,
  currentDelayInMs: number
): Promise<
  | { done: true; result: T }
  | { currentDelayInMs: number; done: false; lastError: Error }
> => {
  try {
    return { done: true, result: await operation() };
  } catch (error) {
    return { done: false, ...(await processRetryFailure(error, attempt, maxRetries, currentDelayInMs)) };
  }
};

async function executeWithRetryInternal<T>(
  operation: () => Promise<T>,
  maxRetries: number = 3,
  delayInMs: number = 1000
): Promise<T> {
  let lastError: Error | undefined;
  let currentDelayInMs = delayInMs;

  for (let attempt = 1; attempt <= maxRetries; attempt += 1) {
    const outcome = await tryOperation(operation, attempt, maxRetries, currentDelayInMs);
    if (outcome.done) return outcome.result;
    currentDelayInMs = outcome.currentDelayInMs;
    lastError = outcome.lastError;
  }

  throw lastError ?? new Error('Retry operation failed without an error');
}

export const executeWithRetry = <T>(
  operation: () => Promise<T>,
  maxRetries: number = 3,
  delayInMs: number = 1000
): Promise<T> => executeWithRetryInternal(operation, maxRetries, delayInMs);
