import { fileStatusSchema, planModelOutputSchema, resolutionPlanSchema } from './ai.schema';

const createMockStructuredPlanOutput = () => ({
  action: 'feature',
  summary: 'Centralize interactive CLI skills',
  steps: ['Add taxonomy manifest', 'Add sync script'],
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

describe('planModelOutputSchema stepIntents', () => {
  it('parses a plan with no stepIntents', () => {
    const plan = planModelOutputSchema.parse(createMockStructuredPlanOutput());

    expect(plan.stepIntents).toBeUndefined();
  });

  it('preserves stepIntents values exactly', () => {
    const plan = planModelOutputSchema.parse({
      ...createMockStructuredPlanOutput(),
      stepIntents: ['goal', null],
    });

    expect(plan.stepIntents).toEqual(['goal', null]);
  });

  it('rejects stepIntents whose length differs from steps', () => {
    const result = planModelOutputSchema.safeParse({
      ...createMockStructuredPlanOutput(),
      stepIntents: ['goal'],
    });

    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain('stepIntents');
  });

  it('applies the same alignment rule to resolutionPlanSchema', () => {
    const result = resolutionPlanSchema.safeParse({
      ...createMockStructuredPlanOutput(),
      estimatedComplexity: 'low',
      stepIntents: ['goal'],
    });

    expect(result.success).toBe(false);
  });
});

describe('fileStatusSchema', () => {
  it('accepts to-delete', () => {
    expect(fileStatusSchema.parse('to-delete')).toBe('to-delete');
  });
});
