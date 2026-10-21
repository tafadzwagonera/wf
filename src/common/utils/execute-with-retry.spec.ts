import { AppError } from '../errors/app.error';
import { executeWithRetry } from './execute-with-retry';

describe('executeWithRetry', () => {
  afterEach(() => jest.restoreAllMocks());

  it('retries a recoverable failure until the operation succeeds', async () => {
    jest.useFakeTimers();
    const consoleLogSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    let attempts = 0;

    const promise = executeWithRetry(async () => {
      attempts += 1;
      if (attempts < 3) {
        throw new AppError('EXECUTION_ERROR', 'temporary failure', null, true);
      }
      return 'done';
    }, 3, 10);

    await jest.runAllTimersAsync();

    await expect(promise).resolves.toBe('done');
    expect(attempts).toBe(3);
    expect(consoleLogSpy).toHaveBeenCalledTimes(2);
  });

  it('throws a non-recoverable AppError without retrying', async () => {
    jest.useFakeTimers();
    const consoleLogSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    const error = new AppError('EXECUTION_ERROR', 'fatal failure', null, false);
    let attempts = 0;

    await expect(executeWithRetry(async () => {
      attempts += 1;
      throw error;
    }, 3, 10)).rejects.toBe(error);

    expect(attempts).toBe(1);
    expect(consoleLogSpy).not.toHaveBeenCalled();
  });
});
