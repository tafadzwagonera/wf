import { isTransientNetworkError, retryOnTransient } from './retry-on-transient';

describe('isTransientNetworkError', () => {
  it.each([
    'Premature close',
    'ECONNRESET',
    'socket hang up',
    'ETIMEDOUT',
    'ECONNREFUSED',
    'fetch failed',
  ])('returns true for "%s"', pattern => {
    expect(isTransientNetworkError(new Error(`Connection: ${pattern}`))).toBe(true);
  });

  it('returns false for non-transient errors', () => {
    expect(isTransientNetworkError(new Error('No BitBucket repository specified.'))).toBe(false);
  });

  it('handles non-Error values', () => {
    expect(isTransientNetworkError('ECONNRESET')).toBe(true);
    expect(isTransientNetworkError('auth failed')).toBe(false);
  });
});

describe('retryOnTransient', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('returns the value on first success', async () => {
    const result = await retryOnTransient(() => Promise.resolve('ok'), { delayInMs: 0 });
    expect(result).toBe('ok');
  });

  it('retries once on transient error and returns second attempt', async () => {
    let calls = 0;
    const fn = async () => {
      calls++;
      if (calls === 1) throw new Error('Premature close');
      return 'recovered';
    };

    const result = await retryOnTransient(fn, { delayInMs: 0 });
    expect(result).toBe('recovered');
    expect(calls).toBe(2);
  });

  it('throws after exhausting retries on persistent transient error', async () => {
    const fn = async () => {
      throw new Error('ECONNRESET');
    };
    await expect(retryOnTransient(fn, { delayInMs: 0 })).rejects.toThrow('ECONNRESET');
  });

  it('throws immediately on non-transient error without retry', async () => {
    let calls = 0;
    const fn = async () => {
      calls++;
      throw new Error('auth failed');
    };

    await expect(retryOnTransient(fn, { delayInMs: 0 })).rejects.toThrow('auth failed');
    expect(calls).toBe(1);
  });

  it('calls onRetry callback before each retry', async () => {
    let calls = 0;
    const mockOnRetry = jest.fn();
    const fn = async () => {
      calls++;
      if (calls === 1) throw new Error('socket hang up');
      return 'ok';
    };

    await retryOnTransient(fn, { delayInMs: 0, onRetry: mockOnRetry });
    expect(mockOnRetry).toHaveBeenCalledTimes(1);
    expect(mockOnRetry).toHaveBeenCalledWith(expect.any(Error), 1);
  });

  it('respects custom maxAttempts', async () => {
    let calls = 0;
    const fn = async () => {
      calls++;
      if (calls < 3) throw new Error('ETIMEDOUT');
      return 'ok';
    };

    const result = await retryOnTransient(fn, { maxAttempts: 3, delayInMs: 0 });
    expect(result).toBe('ok');
    expect(calls).toBe(3);
  });
});
