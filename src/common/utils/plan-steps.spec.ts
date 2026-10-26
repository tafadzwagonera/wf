import { ValidationError } from '../errors/app.error';
import {
  coerceLegacyPlanShape,
  combineLegacyPlanSteps,
  hasAlignedLegacyStepIntents,
  planStepDescriptions,
} from './plan-steps';

describe('combineLegacyPlanSteps', () => {
  it('converts flat string steps to step objects', () => {
    expect(combineLegacyPlanSteps(['Add manifest', 'Add script'])).toEqual([
      { description: 'Add manifest' },
      { description: 'Add script' },
    ]);
  });

  it('zips aligned legacy stepIntents onto their steps and omits null intents', () => {
    const steps = combineLegacyPlanSteps(['Rename guard', 'Update imports'], ['guard.ts declares SharedAuthGuard', null]);

    expect(steps).toEqual([
      { description: 'Rename guard', intent: 'guard.ts declares SharedAuthGuard' },
      { description: 'Update imports' },
    ]);
    expect('intent' in steps[1]).toBe(false);
  });

  it('passes combined step objects through and keeps their own intent', () => {
    expect(combineLegacyPlanSteps([{ description: 'Rename guard', intent: 'own goal' }], ['zipped goal'])).toEqual([
      { description: 'Rename guard', intent: 'own goal' },
    ]);
  });

  it.each([
    ['text', { text: 'From text' }],
    ['title', { title: 'From title' }],
    ['content', { content: 'From content' }],
  ])('reads the legacy %s key as the description', (_key, step) => {
    expect(combineLegacyPlanSteps([step])[0].description).toBe(Object.values(step)[0]);
  });

  it('throws a ValidationError when stepIntents length differs from steps', () => {
    expect(() => combineLegacyPlanSteps(['a', 'b'], ['goal'])).toThrow(ValidationError);
  });

  it('returns an empty list for a non-array steps value', () => {
    expect(combineLegacyPlanSteps(undefined)).toEqual([]);
  });
});

describe('hasAlignedLegacyStepIntents', () => {
  it.each([
    ['stepIntents absent', ['a'], undefined, true],
    ['lengths match', ['a', 'b'], ['x', null], true],
    ['lengths differ', ['a', 'b'], ['x'], false],
  ])('returns %s alignment', (_label, steps, stepIntents, expected) => {
    expect(hasAlignedLegacyStepIntents(steps, stepIntents)).toBe(expected);
  });
});

describe('coerceLegacyPlanShape', () => {
  it('combines legacy steps and removes stepIntents from the payload', () => {
    const coerced = coerceLegacyPlanShape({
      action: 'fix',
      steps: ['Rename guard'],
      stepIntents: ['guard.ts declares SharedAuthGuard'],
    }) as Record<string, unknown>;

    expect(coerced.steps).toEqual([{ description: 'Rename guard', intent: 'guard.ts declares SharedAuthGuard' }]);
    expect('stepIntents' in coerced).toBe(false);
  });

  it('returns the payload unchanged when stepIntents is misaligned', () => {
    const raw = { action: 'fix', steps: ['a', 'b'], stepIntents: ['goal'] };

    expect(coerceLegacyPlanShape(raw)).toBe(raw);
  });

  it('returns the payload unchanged when steps is not an array', () => {
    const raw = { action: 'fix', steps: 'not-a-list' };

    expect(coerceLegacyPlanShape(raw)).toBe(raw);
  });

  it.each([[null], ['plain text'], [42]])('returns a non-object payload %p unchanged', value => {
    expect(coerceLegacyPlanShape(value)).toBe(value);
  });
});

describe('planStepDescriptions', () => {
  it('maps steps to their descriptions', () => {
    expect(planStepDescriptions([{ description: 'a' }, { description: 'b', intent: 'goal' }])).toEqual(['a', 'b']);
  });
});
