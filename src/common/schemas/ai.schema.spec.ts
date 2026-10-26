import { fileStatusSchema, planModelOutputSchema, resolutionPlanSchema } from './ai.schema';

const createMockStructuredPlanOutput = () => ({
  action: 'feature',
  summary: 'Centralize interactive CLI skills',
  steps: [{ description: 'Add taxonomy manifest' }, { description: 'Add sync script', intent: null }],
  affectedFiles: ['src/skills/skill-taxonomy.ts'],
  affectedFilesContext: null,
  affectedRepositories: null,
  newRepositories: null,
  risks: null,
  verification: {
    targeted: [
      {
        id: 'unit-tests',
        run: 'yarn test src/skills/skill-taxonomy.spec.ts',
        policy: 'enforced',
        reason: null,
        earlyExitPattern: null,
        repo: null,
      },
    ],
    waivers: null,
  },
  provider: null,
  source: null,
  timestamp: null,
  phases: [
    {
      label: 'Implement',
      stepIndices: [0, 1],
      verifyAfter: null,
    },
  ],
});

describe('planModelOutputSchema', () => {
  describe('when the model emits null for optional fields (strict structured-output normalization)', () => {
    it('parses the payload instead of rejecting it', () => {
      expect(() => planModelOutputSchema.parse(createMockStructuredPlanOutput())).not.toThrow();
    });

    it('strips top-level nulls to undefined', () => {
      const plan = planModelOutputSchema.parse(createMockStructuredPlanOutput());

      expect(plan.provider).toBeUndefined();
      expect(plan.source).toBeUndefined();
      expect(plan.timestamp).toBeUndefined();
      expect(plan.risks).toBeUndefined();
    });

    it('strips nested nulls inside verification steps and phases', () => {
      const plan = planModelOutputSchema.parse(createMockStructuredPlanOutput());

      expect(plan.verification?.targeted?.[0]?.earlyExitPattern).toBeUndefined();
      expect(plan.verification?.targeted?.[0]?.reason).toBeUndefined();
      expect(plan.verification?.targeted?.[0]?.repo).toBeUndefined();
      expect(plan.verification?.waivers).toBeUndefined();
      expect(plan.phases?.[0]?.verifyAfter).toBeUndefined();
    });
  });
});

describe('planModelOutputSchema steps', () => {
  it('parses steps carrying a description and an intent', () => {
    const plan = planModelOutputSchema.parse({
      ...createMockStructuredPlanOutput(),
      steps: [{ description: 'Rename AuthGuard', intent: 'guard.ts declares SharedAuthGuard' }],
    });

    expect(plan.steps).toEqual([{ description: 'Rename AuthGuard', intent: 'guard.ts declares SharedAuthGuard' }]);
  });

  it('strips a null intent to undefined', () => {
    const plan = planModelOutputSchema.parse(createMockStructuredPlanOutput());

    expect(plan.steps[1].intent).toBeUndefined();
  });

  it('rejects flat string steps', () => {
    const result = planModelOutputSchema.safeParse({
      ...createMockStructuredPlanOutput(),
      steps: ['Add taxonomy manifest'],
    });

    expect(result.success).toBe(false);
  });

  it('drops a legacy stepIntents field', () => {
    const plan = planModelOutputSchema.parse({
      ...createMockStructuredPlanOutput(),
      stepIntents: ['goal', null],
    });

    expect('stepIntents' in plan).toBe(false);
  });

  it('accepts combined steps in resolutionPlanSchema', () => {
    const result = resolutionPlanSchema.safeParse({
      ...createMockStructuredPlanOutput(),
      estimatedComplexity: 'low',
    });

    expect(result.success).toBe(true);
  });
});

describe('fileStatusSchema', () => {
  it('accepts to-delete', () => {
    expect(fileStatusSchema.parse('to-delete')).toBe('to-delete');
  });
});
