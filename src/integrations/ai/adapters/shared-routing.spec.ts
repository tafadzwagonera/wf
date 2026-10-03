import { buildPlanContext, buildImplementerRulesSection, resolveModelRouting, resolveProviderModel, buildTaskBrief, buildBehavioralContext, detectMechanicalTask } from './shared-routing';
import { normalizeFileEntries } from '../ai.service';
import type { VerificationScript } from '../../../agents/interfaces';
import type { ResolutionPlan } from '../ai.service';
import { ConfigService } from '@nestjs/config';

describe('normalizeFileEntries', () => {
  it('converts string entries to FileEntry with status found', () => {
    const result = normalizeFileEntries(['src/a.ts', 'src/b.ts']);
    expect(result).toEqual([
      { filePath: 'src/a.ts', status: 'found' },
      { filePath: 'src/b.ts', status: 'found' },
    ]);
  });

  it('passes through FileEntry objects unchanged', () => {
    const entries = [
      { filePath: 'src/a.ts', status: 'found' as const },
      { filePath: 'src/b.ts', status: 'to-create' as const },
    ];
    const result = normalizeFileEntries(entries);
    expect(result).toEqual(entries);
  });

  it('handles mixed string and FileEntry arrays', () => {
    const result = normalizeFileEntries(['src/a.ts', { filePath: 'src/b.ts', status: 'to-create' as const }]);
    expect(result).toEqual([
      { filePath: 'src/a.ts', status: 'found' },
      { filePath: 'src/b.ts', status: 'to-create' },
    ]);
  });

  it('returns empty array for empty input', () => {
    expect(normalizeFileEntries([])).toEqual([]);
  });
});

describe('buildPlanContext', () => {
  const baseParams = {
    ticketKey: 'WBP-1',
    repoDir: '/tmp/repo-a',
    repoName: 'repo-a',
    repoFiles: ['repo-a/src/example.ts'],
    trackedFilePaths: ['repo-a/src/example.ts'],
    verificationScripts: [{ id: 'build', command: 'yarn build', policy: 'enforced' }] as VerificationScript[],
    planSteps: ['Update source file', 'Add tests'],
    planSummary: 'Fix the widget',
    planAction: 'fix' as const,
  };

  it('produces correct output with all fields', () => {
    const result = buildPlanContext({
      ...baseParams,
      contextFiles: ['repo-a/package.json'],
      planRisks: ['May break build'],
    });

    expect(result).toContain('Repository directory: /tmp/repo-a');
    expect(result).toContain('Ticket key: WBP-1');
    expect(result).toContain('Fix the widget');
    expect(result).toContain('1. Update source file');
    expect(result).toContain('2. Add tests');
    expect(result).toContain('src/example.ts');
    expect(result).toContain('yarn build');
    expect(result).toContain('bug fix');
  });

  it('omits context files section when empty', () => {
    const result = buildPlanContext({ ...baseParams, contextFiles: [] });
    expect(result).not.toContain('Files for context');
  });

  it('omits context files section when undefined', () => {
    const result = buildPlanContext(baseParams);
    expect(result).not.toContain('Files for context');
  });

  it('includes context files section when non-empty', () => {
    const result = buildPlanContext({
      ...baseParams,
      contextFiles: ['repo-a/package.json', 'repo-a/tsconfig.json'],
    });
    expect(result).toContain('Files for context (read-only — do NOT edit these):');
    expect(result).toContain('package.json');
    expect(result).toContain('tsconfig.json');
  });

  it('renders feature action description', () => {
    const result = buildPlanContext({
      ...baseParams,
      planAction: 'feature',
    });
    expect(result).toContain('new feature');
  });

  it('renders not specified for unknown action', () => {
    const result = buildPlanContext({
      ...baseParams,
      planAction: undefined,
    });
    expect(result).toContain('(not specified)');
  });

  it('shows (none) when planSummary is empty', () => {
    const result = buildPlanContext({
      ...baseParams,
      planSummary: undefined,
    });
    expect(result).toContain('Plan summary:\n(none)');
  });

  it('includes unplanned-file verification warning in implementer rules', () => {
    const rules = buildImplementerRulesSection({
      read: 'Read', write: 'Write', edit: 'Edit', search: 'Grep', glob: 'Glob', verify: 'Bash',
    });
    expect(rules).toContain('file not listed in "Files to implement"');
    expect(rules).toContain('verification whitelist is frozen');
  });

  it('tells the implementer to search broadly, not with word-boundary-only patterns', () => {
    const rules = buildImplementerRulesSection({
      read: 'Read', write: 'Write', edit: 'Edit', search: 'Grep', glob: 'Glob', verify: 'Bash',
    });
    expect(rules).toContain('case-insensitive substring search');
    expect(rules).toContain('kebab-case');
    expect(rules).toContain('not a word-boundary-only pattern');
  });

  it('tells the implementer to delete files it edited that are no longer referenced', () => {
    const rules = buildImplementerRulesSection({
      read: 'Read', write: 'Write', edit: 'Edit', search: 'Grep', glob: 'Glob', verify: 'Bash',
    });
    expect(rules).toContain('zero remaining references');
    expect(rules).toContain('delete it');
  });

  it('inlines skillFragment content when provided', () => {
    const result = buildPlanContext({
      ...baseParams,
      skillFragment: '## Skill: writing-plans\nContent A\n\n## Skill: test-driven-development\nContent B',
    });

    expect(result).toContain('## Skill: writing-plans');
    expect(result).toContain('## Skill: test-driven-development');
  });

  it('omits skill content when skillFragment is undefined', () => {
    const result = buildPlanContext(baseParams);
    expect(result).not.toContain('## Skill:');
  });

  it('includes phase checkpoint instructions when plan has phases', () => {
    const result = buildPlanContext({
      ...baseParams,
      planSteps: ['Step A', 'Step B', 'Step C'],
      phases: [
        { label: 'Schema changes', stepIndices: [0, 1], verifyAfter: ['yarn test -- src/shared/'] },
        { label: 'Service updates', stepIndices: [2] },
      ],
    });

    expect(result).toContain('## Phase checkpoints');
    expect(result).toContain('Phase 1: Schema changes');
    expect(result).toContain('Phase 2: Service updates');
    expect(result).toContain('yarn test -- src/shared/');
    expect(result).toContain('Verify: (none)');
  });

  it('omits phase section when plan has no phases', () => {
    const result = buildPlanContext(baseParams);
    expect(result).not.toContain('## Phase checkpoints');
  });

  it('omits phase section when phases is an empty array', () => {
    const result = buildPlanContext({ ...baseParams, phases: [] });
    expect(result).not.toContain('## Phase checkpoints');
  });
});

describe('resolveModelRouting', () => {
  const defaultMechanicalModel = 'claude-haiku-4-5-20251001';
  const fallbackDefaultModel = 'claude-sonnet-4-6';

  const createMockPlan = (estimatedComplexity: 'low' | 'medium' | 'high'): ResolutionPlan => ({
    action: 'fix' as const,
    summary: 'Test plan',
    steps: ['Step 1'],
    estimatedComplexity,
    affectedFiles: estimatedComplexity === 'low' ? Array(5).fill({ filePath: 'src/test.ts', status: 'found' as const }) : [],
  });

  const createMockConfigService = (configMap: Record<string, unknown>): ConfigService => {
    const mockService = new ConfigService();
    jest.spyOn(mockService, 'get').mockImplementation((key: string) => configMap[key]);
    return mockService;
  };

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('throws when stages.implement.model and stages.implement.models are both set', () => {
    const mockConfigService = createMockConfigService({
      'stages.implement.model': 'claude-sonnet-4-6',
      'stages.implement.models': { mechanical: 'claude-haiku-4-5' },
    });

    expect(() =>
      resolveModelRouting({
        routing: 'auto',
        fallbackDefaultModel,
        defaultMechanicalModel,
        configService: mockConfigService,
        plan: createMockPlan('low'),
        adapterLabel: 'test-adapter',
      })
    ).toThrow('mutually exclusive');
  });

  it('singleModel overrides mechanical fallback on auto-routing', () => {
    const mockConfigService = createMockConfigService({
      'stages.implement.model': 'claude-opus-4-6',
      'stages.implement.models': undefined,
    });

    const result = resolveModelRouting({
      routing: 'auto',
      fallbackDefaultModel,
      defaultMechanicalModel,
      configService: mockConfigService,
      plan: createMockPlan('low'),
      adapterLabel: 'test-adapter',
    });

    expect(result.model).toBe('claude-opus-4-6');
    expect(result.logMessage).toContain('claude-opus-4-6');
  });

  it('models.mechanical takes precedence over singleModel', () => {
    const mockConfigService = createMockConfigService({
      'stages.implement.model': undefined,
      'stages.implement.models': { mechanical: 'claude-haiku-custom' },
    });

    const result = resolveModelRouting({
      routing: 'auto',
      fallbackDefaultModel,
      defaultMechanicalModel,
      configService: mockConfigService,
      plan: createMockPlan('low'),
      adapterLabel: 'test-adapter',
    });

    expect(result.model).toBe('claude-haiku-custom');
    expect(result.logMessage).toContain('claude-haiku-custom');
  });

  it('uses hardcoded default when no config is set', () => {
    const mockConfigService = createMockConfigService({
      'stages.implement.model': undefined,
      'stages.implement.models': undefined,
    });

    const result = resolveModelRouting({
      routing: 'auto',
      fallbackDefaultModel,
      defaultMechanicalModel,
      configService: mockConfigService,
      plan: createMockPlan('low'),
      adapterLabel: 'test-adapter',
    });

    expect(result.model).toBe(defaultMechanicalModel);
    expect(result.logMessage).toContain(defaultMechanicalModel);
  });

  it('routing default forces default model and skips mechanical detection', () => {
    const mockConfigService = createMockConfigService({
      'stages.implement.model': 'claude-opus-4-6',
      'stages.implement.models': undefined,
    });

    const result = resolveModelRouting({
      routing: 'default',
      fallbackDefaultModel,
      defaultMechanicalModel,
      configService: mockConfigService,
      plan: createMockPlan('low'),
      adapterLabel: 'test-adapter',
    });

    expect(result.model).toBe('claude-opus-4-6');
    expect(result.logMessage).toContain('default — user override');
  });

  it('auto-routes medium complexity plans to mechanical when targeted writes exceed the threshold', () => {
    const mockConfigService = createMockConfigService({
      'stages.implement.model': undefined,
      'stages.implement.models': undefined,
      'stages.implement.modelRoutingThresholds': { maxTargetedWritesForDefault: 3, maxPlanStepsForDefault: 10 },
    });
    const plan = {
      ...createMockPlan('medium'),
      affectedFiles: Array.from({ length: 4 }, (_, i) => ({ filePath: `src/f${i}.ts`, status: 'found' as const })),
    };

    const result = resolveModelRouting({
      routing: 'auto',
      fallbackDefaultModel,
      defaultMechanicalModel,
      configService: mockConfigService,
      plan,
      adapterLabel: 'test-adapter',
    });

    expect(result.model).toBe(defaultMechanicalModel);
    expect(result.logMessage).toContain('targeted writes threshold exceeded');
  });

  it('auto-routes high complexity plans to mechanical when plan steps exceed the threshold', () => {
    const mockConfigService = createMockConfigService({
      'stages.implement.model': undefined,
      'stages.implement.models': undefined,
      'stages.implement.modelRoutingThresholds': { maxTargetedWritesForDefault: 10, maxPlanStepsForDefault: 2 },
    });
    const plan = {
      ...createMockPlan('high'),
      steps: ['Step 1', 'Step 2', 'Step 3'],
    };

    const result = resolveModelRouting({
      routing: 'auto',
      fallbackDefaultModel,
      defaultMechanicalModel,
      configService: mockConfigService,
      plan,
      adapterLabel: 'test-adapter',
    });

    expect(result.model).toBe(defaultMechanicalModel);
    expect(result.logMessage).toContain('plan steps threshold exceeded');
  });

  it('keeps high complexity plans on the default model below thresholds', () => {
    const mockConfigService = createMockConfigService({
      'stages.implement.model': undefined,
      'stages.implement.models': undefined,
      'stages.implement.modelRoutingThresholds': { maxTargetedWritesForDefault: 10, maxPlanStepsForDefault: 10 },
    });

    const result = resolveModelRouting({
      routing: 'auto',
      fallbackDefaultModel,
      defaultMechanicalModel,
      configService: mockConfigService,
      plan: createMockPlan('high'),
      adapterLabel: 'test-adapter',
    });

    expect(result.model).toBe(fallbackDefaultModel);
    expect(result.logMessage).toContain('high complexity task');
  });

  it('detectMechanicalTask counts targeted writes from affectedFiles only', () => {
    const result = detectMechanicalTask({
      ...createMockPlan('medium'),
      affectedFiles: [
        { filePath: 'src/a.ts', status: 'found' },
        { filePath: 'src/b.ts', status: 'to-create' },
      ],
      affectedFilesContext: Array.from({ length: 20 }, (_, i) => ({ filePath: `src/context-${i}.ts`, status: 'found' as const })),
    }, { maxTargetedWritesForDefault: 1, maxPlanStepsForDefault: 10 });

    expect(result.isMechanical).toBe(true);
    expect(result.reason).toContain('2 targeted writes');
  });
});

describe('resolveProviderModel', () => {
  const createMockConfigService = (configMap: Record<string, unknown>): ConfigService => {
    const mockService = new ConfigService();
    jest.spyOn(mockService, 'get').mockImplementation((key: string) => configMap[key]);
    return mockService;
  };

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('returns the model for the matching provider', () => {
    const configService = createMockConfigService({
      'ai.providers': [
        { provider: 'anthropic', model: 'claude-sonnet-4-6' },
        { provider: 'openai', model: 'gpt-5.4' },
      ],
    });
    expect(resolveProviderModel(configService, 'anthropic', 'fallback')).toBe('claude-sonnet-4-6');
    expect(resolveProviderModel(configService, 'openai', 'fallback')).toBe('gpt-5.4');
  });

  it('returns fallback when provider is not in the array', () => {
    const configService = createMockConfigService({
      'ai.providers': [{ provider: 'openai', model: 'gpt-5.4' }],
    });
    expect(resolveProviderModel(configService, 'anthropic', 'claude-sonnet-4-6')).toBe('claude-sonnet-4-6');
  });

  it('returns fallback when ai.providers is undefined', () => {
    const configService = createMockConfigService({ 'ai.providers': undefined });
    expect(resolveProviderModel(configService, 'anthropic', 'claude-sonnet-4-6')).toBe('claude-sonnet-4-6');
  });
});

describe('buildTaskBrief', () => {
  const baseParams = {
    ticketKey: 'WBP-42',
    repoName: 'repo-b',
    repoFiles: ['repo-b/src/widget.ts'],
    trackedFilePaths: ['repo-b/src/widget.ts'],
    verificationScripts: [{ id: 'test', command: 'yarn test', policy: 'enforced' }] as VerificationScript[],
    planSteps: ['Read existing code', 'Apply fix'],
    planSummary: 'Fix the widget bug',
    planAction: 'fix' as const,
  };

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('contains ticket key, plan summary, action, step numbers, file list, and verification commands', () => {
    const result = buildTaskBrief(baseParams);
    expect(result).toContain('Ticket key: WBP-42');
    expect(result).toContain('Fix the widget bug');
    expect(result).toContain('bug fix');
    expect(result).toContain('1. Read existing code');
    expect(result).toContain('2. Apply fix');
    expect(result).toContain('widget.ts');
    expect(result).toContain('yarn test');
  });

  it('does not contain role line or repository directory', () => {
    const result = buildTaskBrief(baseParams);
    expect(result).not.toContain('You are an expert software engineer');
    expect(result).not.toContain('Repository directory:');
  });

  it('includes risks section when planRisks is provided', () => {
    const result = buildTaskBrief({ ...baseParams, planRisks: ['May break build'] });
    expect(result).toContain('Risks and considerations:');
    expect(result).toContain('May break build');
  });

  it('omits risks section when planRisks is undefined', () => {
    const result = buildTaskBrief(baseParams);
    expect(result).not.toContain('Risks and considerations:');
  });

  it('includes context files section when contextFiles is provided', () => {
    const result = buildTaskBrief({ ...baseParams, contextFiles: ['repo-b/package.json'] });
    expect(result).toContain('Files for context (read-only — do NOT edit these):');
    expect(result).toContain('package.json');
  });

  it('inlines skillFragment content when provided', () => {
    const result = buildTaskBrief({ ...baseParams, skillFragment: '## Skill: test-driven-development\nContent' });
    expect(result).toContain('## Skill: test-driven-development');
  });
});

describe('buildBehavioralContext', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('contains role identity and repository directory', () => {
    const result = buildBehavioralContext('/tmp/my-repo');
    expect(result).toContain('You are an expert software engineer implementing code changes inside a repository.');
    expect(result).toContain('Repository directory: /tmp/my-repo');
  });

  it('does not contain ticket key or plan summary', () => {
    const result = buildBehavioralContext('/tmp/my-repo');
    expect(result).not.toContain('Ticket key:');
    expect(result).not.toContain('Plan summary:');
  });
});
