import { restoreEnv, withEnv } from './env';

describe('withEnv / restoreEnv', () => {
  afterEach(() => {
    restoreEnv();
    jest.restoreAllMocks();
  });

  it('overrides a variable and restores the original value', () => {
    const original = process.env['WF_ENV_SPEC_PROBE'];
    withEnv({ WF_ENV_SPEC_PROBE: 'overridden' });
    expect(process.env['WF_ENV_SPEC_PROBE']).toBe('overridden');
    restoreEnv();
    expect(process.env['WF_ENV_SPEC_PROBE']).toBe(original);
  });

  it('deletes a variable when the override is undefined', () => {
    withEnv({ WF_ENV_SPEC_PROBE: 'present' });
    withEnv({ WF_ENV_SPEC_PROBE: undefined, WF_ENV_SPEC_UNSET: undefined });
    expect('WF_ENV_SPEC_PROBE' in process.env).toBe(false);
    expect('WF_ENV_SPEC_UNSET' in process.env).toBe(false);
  });

  it('restores the original object identity', () => {
    const saved = process.env;
    withEnv({ WF_ENV_SPEC_PROBE: 'x' });
    expect(process.env).not.toBe(saved);
    restoreEnv();
    expect(process.env).toBe(saved);
  });

  it('accumulates repeated overrides and restores to the first original', () => {
    const saved = process.env;
    withEnv({ WF_ENV_SPEC_PROBE: 'first' });
    withEnv({ WF_ENV_SPEC_OTHER: 'second' });
    expect(process.env['WF_ENV_SPEC_PROBE']).toBe('first');
    expect(process.env['WF_ENV_SPEC_OTHER']).toBe('second');
    restoreEnv();
    expect(process.env).toBe(saved);
    expect('WF_ENV_SPEC_OTHER' in process.env).toBe(false);
  });

  it('is a no-op when nothing was replaced, including repeated calls', () => {
    const saved = process.env;
    restoreEnv();
    restoreEnv();
    expect(process.env).toBe(saved);
  });

  it('discards direct process.env writes made while a replacement is active', () => {
    const original = process.env['WF_ENV_SPEC_STRAY'];
    const wasPresent = 'WF_ENV_SPEC_STRAY' in process.env;
    withEnv({ WF_ENV_SPEC_PROBE: 'x' });
    process.env['WF_ENV_SPEC_STRAY'] = 'leaked';
    restoreEnv();
    expect('WF_ENV_SPEC_STRAY' in process.env).toBe(wasPresent);
    expect(process.env['WF_ENV_SPEC_STRAY']).toBe(original);
  });
});
