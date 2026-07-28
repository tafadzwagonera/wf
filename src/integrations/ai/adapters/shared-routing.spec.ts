import { buildPlanContext, resolveModelRouting, resolveProviderModel } from './shared-routing';
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

  it('includes skill invocation hints when skillNames are provided', () => {
    const result = buildPlanContext({
      ...baseParams,
      skillNames: ['writing-plans', 'test-driven-development'],
    });

    expect(result).toContain("Skill('writing-plans')");
    expect(result).toContain("Skill('test-driven-development')");
    expect(result).toContain('Skill-specific instructions:');
  });

  it('omits skill section when skillNames is an empty array', () => {
    const result = buildPlanContext({
      ...baseParams,
      skillNames: [],
    });

    expect(result).not.toContain('Skill-specific instructions:');
  });

  it('omits skill section when skillNames is omitted', () => {
    const result = buildPlanContext(baseParams);
    expect(result).not.toContain('Skill-specific instructions:');
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
