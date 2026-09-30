import {
  normalizedImplementStageConfigSchema,
  wfConfigSchema,
  wfImplementStageConfigSchema,
  wfReviewStageConfigSchema,
  normalizedReviewStageConfigSchema,
} from './config.schema';

describe('wfConfigSchema git.branchNamePattern', () => {
  it('accepts a valid regex pattern', () => {
    expect(() => wfConfigSchema.parse({ git: { branchNamePattern: '^team\\/[a-z-]+$' } })).not.toThrow();
  });

  it('accepts an absent pattern', () => {
    expect(() => wfConfigSchema.parse({ git: {} })).not.toThrow();
  });

  it('rejects an invalid regex pattern with a clear message', () => {
    expect(() => wfConfigSchema.parse({ git: { branchNamePattern: '[' } })).toThrow(
      'must be a valid regular expression'
    );
  });
});

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

  it('accepts planStepVerification with mode: pull', () => {
    expect(() =>
      wfImplementStageConfigSchema.parse({ provider: 'anthropic', planStepVerification: { mode: 'pull' } }),
    ).not.toThrow();
  });

  it('accepts planStepVerification with mode: push', () => {
    expect(() =>
      wfImplementStageConfigSchema.parse({ provider: 'anthropic', planStepVerification: { mode: 'push' } }),
    ).not.toThrow();
  });

  it('rejects planStepVerification with an unknown mode', () => {
    expect(() =>
      wfImplementStageConfigSchema.parse({ provider: 'anthropic', planStepVerification: { mode: 'poll' } }),
    ).toThrow();
  });
});

describe('wfImplementStageConfigSchema modelRoutingThresholds', () => {
  afterEach(() => jest.restoreAllMocks());

  it('accepts targeted write and plan step thresholds', () => {
    expect(() =>
      wfImplementStageConfigSchema.parse({
        provider: 'anthropic',
        modelRoutingThresholds: {
          maxTargetedWritesForDefault: 8,
          maxPlanStepsForDefault: 12,
        },
      }),
    ).not.toThrow();
  });

  it('rejects zero targeted write threshold', () => {
    expect(() =>
      wfImplementStageConfigSchema.parse({
        provider: 'anthropic',
        modelRoutingThresholds: { maxTargetedWritesForDefault: 0 },
      }),
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

  it('accepts the planStepVerification mode key', () => {
    expect(() =>
      normalizedImplementStageConfigSchema.parse({
        provider: 'anthropic',
        backend: 'agent',
        planStepVerification: { enabled: true, stallWindow: 3, mode: 'pull' },
      }),
    ).not.toThrow();
  });
});

describe('normalizedImplementStageConfigSchema modelRoutingThresholds', () => {
  afterEach(() => jest.restoreAllMocks());

  it('accepts modelRoutingThresholds', () => {
    expect(() =>
      normalizedImplementStageConfigSchema.parse({
        provider: 'anthropic',
        backend: 'agent',
        modelRoutingThresholds: {
          maxTargetedWritesForDefault: 8,
          maxPlanStepsForDefault: 12,
        },
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
