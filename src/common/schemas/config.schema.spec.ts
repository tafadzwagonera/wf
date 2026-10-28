import {
  normalizedImplementStageConfigSchema,
  wfConfigSchema,
  wfDesignConformanceConfigSchema,
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

describe('wfConfigSchema loader parity', () => {
  it('rejects outputFormat on the implement stage', () => {
    expect(wfConfigSchema.safeParse({ stages: { implement: { provider: 'anthropic', outputFormat: 'json' } } }).success)
      .toBe(false);
  });

  it('rejects an empty stage model', () => {
    expect(wfConfigSchema.safeParse({ stages: { plan: { provider: 'anthropic', model: '' } } }).success).toBe(false);
  });

  it('rejects verificationConditions with neither policyFile nor scripts', () => {
    expect(wfConfigSchema.safeParse({ stages: { create: { verificationConditions: {} } } }).success).toBe(false);
  });

  it('rejects an unknown top-level key', () => {
    expect(wfConfigSchema.safeParse({ unknownKey: true }).success).toBe(false);
  });

  it('rejects an unknown modelRoutingThresholds key', () => {
    const result = wfConfigSchema.safeParse({
      stages: { implement: { provider: 'anthropic', modelRoutingThresholds: { unknownThreshold: 1 } } },
    });

    expect(result.success).toBe(false);
  });

  it('rejects an invalid atlassian.baseUrl', () => {
    expect(wfConfigSchema.safeParse({ atlassian: { baseUrl: 'not-a-url' } }).success).toBe(false);
  });

  it('rejects an invalid atlassian.email', () => {
    expect(wfConfigSchema.safeParse({ atlassian: { email: 'not-an-email' } }).success).toBe(false);
  });

  it.each(['default', 'mechanical'])('rejects an empty implement.models.%s', key => {
    const result = wfConfigSchema.safeParse({
      stages: { implement: { provider: 'anthropic', models: { [key]: '' } } },
    });

    expect(result.success).toBe(false);
  });

  it.each(['review', 'generate', 'commit'])('rejects skills on the %s stage', stage => {
    const result = wfConfigSchema.safeParse({ stages: { [stage]: { provider: 'anthropic', skills: ['x'] } } });

    expect(result.success).toBe(false);
  });

  it.each(['plan', 'review', 'generate', 'commit'])('rejects an unknown key on the %s stage', stage => {
    const result = wfConfigSchema.safeParse({ stages: { [stage]: { provider: 'anthropic', unknownKey: true } } });

    expect(result.success).toBe(false);
  });

  it.each([
    ['atlassian url and email', { atlassian: { baseUrl: 'https://example.atlassian.net', email: 'dev@example.com' } }],
    ['plan skills', { stages: { plan: { provider: 'anthropic', skills: ['writing-plans'] } } }],
    ['plan figma', { stages: { plan: { provider: 'anthropic', figma: true } } }],
    ['review sonar', { stages: { review: { provider: 'anthropic', sonar: true } } }],
    ['review maxDiffLength', { stages: { review: { provider: 'anthropic', maxDiffLength: 1000 } } }],
    ['generate stage', { stages: { generate: { provider: 'anthropic' } } }],
    ['commit stage', { stages: { commit: { provider: 'anthropic' } } }],
  ])('accepts %s', (_label, config) => {
    expect(wfConfigSchema.safeParse(config).success).toBe(true);
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

  it('accepts backend: agent with openai provider', () => {
    expect(() => wfImplementStageConfigSchema.parse({
      provider: 'anthropic',
      planStepVerification: { provider: 'openai', model: 'gpt-5.6-terra', backend: 'agent' },
    })).not.toThrow();
  });
});

describe('designConformance config', () => {
  afterEach(() => jest.restoreAllMocks());

  it('leaves designConformance undefined when omitted', () => {
    const parsed = wfImplementStageConfigSchema.parse({ provider: 'anthropic' });
    expect(parsed.designConformance).toBeUndefined();
  });

  it('keeps designConformance disabled when enabled is omitted', () => {
    const parsed = wfImplementStageConfigSchema.parse({
      provider: 'anthropic', designConformance: { backend: 'cli', model: 'claude-haiku-4-5' },
    });
    expect(parsed.designConformance).toEqual({ backend: 'cli', model: 'claude-haiku-4-5' });
    expect(parsed.designConformance?.enabled).toBeUndefined();
  });

  it('accepts an empty designConformance object', () => {
    const parsed = wfImplementStageConfigSchema.parse({ provider: 'anthropic', designConformance: {} });
    expect(parsed.designConformance).toEqual({});
  });

  it('accepts a positive integer stallWindow', () => {
    expect(wfDesignConformanceConfigSchema.parse({ stallWindow: 2 })).toEqual({ stallWindow: 2 });
  });

  it.each([0, 1.5])('rejects stallWindow %s', stallWindow => {
    expect(wfDesignConformanceConfigSchema.safeParse({ stallWindow }).success).toBe(false);
  });

  it('accepts maxScreenshots, provider, model and backend', () => {
    const parsed = wfImplementStageConfigSchema.parse({
      provider: 'anthropic',
      designConformance: {
        enabled: true, maxScreenshots: 5, provider: 'openai', model: 'gpt-5.6-luna', backend: 'cli',
      },
    });
    expect(parsed.designConformance).toEqual({
      enabled: true, maxScreenshots: 5, provider: 'openai', model: 'gpt-5.6-luna', backend: 'cli',
    });
  });

  it('accepts a model without a provider', () => {
    const parsed = wfImplementStageConfigSchema.parse({
      provider: 'anthropic', designConformance: { enabled: true, model: 'claude-haiku-4-5-20251001' },
    });
    expect(parsed.designConformance?.model).toBe('claude-haiku-4-5-20251001');
  });

  it('rejects a provider without a model', () => {
    const result = wfImplementStageConfigSchema.safeParse({
      provider: 'anthropic', designConformance: { enabled: true, provider: 'openai' },
    });
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain("'model' is required when 'provider' is set");
  });

  it.each(['agent', 'cli', 'standard'])('accepts backend %s', backend => {
    const parsed = wfImplementStageConfigSchema.parse({
      provider: 'anthropic', designConformance: { enabled: true, backend },
    });
    expect(parsed.designConformance?.backend).toBe(backend);
  });

  it('rejects an unknown backend and unknown keys', () => {
    expect(() =>
      wfImplementStageConfigSchema.parse({ provider: 'anthropic', designConformance: { backend: 'sdk' } }),
    ).toThrow();
    expect(() =>
      wfImplementStageConfigSchema.parse({ provider: 'anthropic', designConformance: { unknownKnob: 3 } }),
    ).toThrow();
  });

  it.each([0, -1, 1.5])('rejects maxScreenshots of %s', maxScreenshots => {
    expect(() =>
      wfImplementStageConfigSchema.parse({ provider: 'anthropic', designConformance: { maxScreenshots } }),
    ).toThrow();
  });

  it('accepts designConformance in the normalized implement config', () => {
    const parsed = normalizedImplementStageConfigSchema.parse({
      provider: 'anthropic', backend: 'agent', designConformance: { enabled: true },
    });
    expect(parsed.designConformance).toEqual({ enabled: true });
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
