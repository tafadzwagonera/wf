import { normalizedImplementStageConfigSchema, wfImplementStageConfigSchema } from './config.schema';

describe('wfImplementStageConfigSchema planStepVerification', () => {
  afterEach(() => jest.restoreAllMocks());

  it('accepts an object without planStepVerification', () => {
    expect(() => wfImplementStageConfigSchema.parse({ provider: 'anthropic' })).not.toThrow();
  });

  it('accepts planStepVerification with enabled: false', () => {
    expect(() =>
      wfImplementStageConfigSchema.parse({ provider: 'anthropic', planStepVerification: { enabled: false } }),
    ).not.toThrow();
  });

  it('accepts planStepVerification with stallWindow: 5', () => {
    expect(() =>
      wfImplementStageConfigSchema.parse({ provider: 'anthropic', planStepVerification: { stallWindow: 5 } }),
    ).not.toThrow();
  });

  it('rejects planStepVerification with stallWindow: 0', () => {
    expect(() =>
      wfImplementStageConfigSchema.parse({ provider: 'anthropic', planStepVerification: { stallWindow: 0 } }),
    ).toThrow();
  });
});

describe('normalizedImplementStageConfigSchema planStepVerification', () => {
  afterEach(() => jest.restoreAllMocks());

  it('accepts the planStepVerification key', () => {
    expect(() =>
      normalizedImplementStageConfigSchema.parse({
        provider: 'anthropic',
        backend: 'agent',
        planStepVerification: { enabled: true, stallWindow: 3 },
      }),
    ).not.toThrow();
  });
});
