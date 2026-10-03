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

  it('accepts push and pull verification modes', () => {
    expect(() =>
      wfImplementStageConfigSchema.parse({ provider: 'anthropic', planStepVerification: { mode: 'push' } }),
    ).not.toThrow();
    expect(() =>
      wfImplementStageConfigSchema.parse({ provider: 'anthropic', planStepVerification: { mode: 'pull' } }),
    ).not.toThrow();
  });

  it('rejects an unknown verification mode', () => {
    expect(() =>
      wfImplementStageConfigSchema.parse({ provider: 'anthropic', planStepVerification: { mode: 'poll' } }),
    ).toThrow();
  });

  it('requires a model when an assessor provider is configured', () => {
    expect(() =>
      wfImplementStageConfigSchema.parse({ provider: 'anthropic', planStepVerification: { provider: 'openai' } }),
    ).toThrow("'model' is required when 'provider' is set");
  });

  it('accepts model-only and provider-plus-model assessor targets', () => {
    expect(() =>
      wfImplementStageConfigSchema.parse({ provider: 'anthropic', planStepVerification: { model: 'claude-sonnet-4-6' } }),
    ).not.toThrow();
    expect(() => wfImplementStageConfigSchema.parse({
      provider: 'anthropic',
      planStepVerification: { provider: 'openai', model: 'gpt-5.6-terra' },
    })).not.toThrow();
  });

  it('rejects unsupported effective providers in pull mode', () => {
    expect(() => wfImplementStageConfigSchema.parse({
      provider: 'google', planStepVerification: { mode: 'pull' },
    })).toThrow('requires an anthropic or openai provider');
    expect(() => wfImplementStageConfigSchema.parse({
      provider: 'anthropic', planStepVerification: { mode: 'pull', provider: 'deepseek', model: 'deepseek-chat' },
    })).toThrow('requires an anthropic or openai provider');
  });

  it('allows google overrides in push mode', () => {
    expect(() => wfImplementStageConfigSchema.parse({
      provider: 'anthropic', planStepVerification: { mode: 'push', provider: 'google', model: 'gemini-2.5-pro' },
    })).not.toThrow();
  });

  it('accepts backend: cli with anthropic provider', () => {
    expect(() => wfImplementStageConfigSchema.parse({
      provider: 'anthropic',
      planStepVerification: { provider: 'anthropic', model: 'claude-haiku-4-5-20251001', backend: 'cli' },
    })).not.toThrow();
  });

  it('accepts backend: cli when no provider is set in planStepVerification', () => {
    expect(() => wfImplementStageConfigSchema.parse({
      provider: 'anthropic',
      planStepVerification: { backend: 'cli' },
    })).not.toThrow();
  });

  it('rejects backend: cli with a non-anthropic provider', () => {
    expect(() => wfImplementStageConfigSchema.parse({
      provider: 'anthropic',
      planStepVerification: { provider: 'openai', model: 'gpt-5.6-terra', backend: 'cli' },
    })).toThrow("backend 'cli' is only supported for the 'anthropic' provider");
  });

  it('accepts backend: agent with openai provider', () => {
    expect(() => wfImplementStageConfigSchema.parse({
      provider: 'anthropic',
      planStepVerification: { provider: 'openai', model: 'gpt-5.6-terra', backend: 'agent' },
    })).not.toThrow();
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
