import {
  normalizedImplementStageConfigSchema,
  wfImplementStageConfigSchema,
  wfReviewStageConfigSchema,
  normalizedReviewStageConfigSchema,
} from './config.schema';

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

describe('wfReviewStageConfigSchema knobs', () => {
  afterEach(() => jest.restoreAllMocks());

  it('accepts maxDiffLength and epilogueTimeoutMs alongside required provider', () => {
    const result = wfReviewStageConfigSchema.safeParse({
      provider: 'anthropic',
      maxDiffLength: 50_000,
      epilogueTimeoutMs: 60_000,
    });
    expect(result.success).toBe(true);
  });

  it('rejects maxDiffLength of 0', () => {
    const result = wfReviewStageConfigSchema.safeParse({
      provider: 'anthropic',
      maxDiffLength: 0,
    });
    expect(result.success).toBe(false);
  });

  it('rejects negative epilogueTimeoutMs', () => {
    const result = wfReviewStageConfigSchema.safeParse({
      provider: 'anthropic',
      epilogueTimeoutMs: -1,
    });
    expect(result.success).toBe(false);
  });

  it('rejects non-integer maxDiffLength', () => {
    const result = wfReviewStageConfigSchema.safeParse({
      provider: 'anthropic',
      maxDiffLength: 1.5,
    });
    expect(result.success).toBe(false);
  });
});

describe('normalizedReviewStageConfigSchema', () => {
  afterEach(() => jest.restoreAllMocks());

  it('accepts both knobs alongside required normalized fields', () => {
    const result = normalizedReviewStageConfigSchema.safeParse({
      provider: 'anthropic',
      model: 'claude-sonnet-4-20250514',
      backend: 'agent',
      maxDiffLength: 50_000,
      epilogueTimeoutMs: 30_000,
    });
    expect(result.success).toBe(true);
  });

  it('accepts zero epilogueTimeoutMs (disables wait)', () => {
    const result = normalizedReviewStageConfigSchema.safeParse({
      provider: 'anthropic',
      model: 'claude-sonnet-4-20250514',
      backend: 'agent',
      epilogueTimeoutMs: 0,
    });
    expect(result.success).toBe(true);
  });
});
