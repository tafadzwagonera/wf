import {
  coerceLegacyPlanShape,
  combineLegacyPlanSteps,
  planStepDescriptions,
} from './plan-steps';

describe('combineLegacyPlanSteps', () => {
  it('converts flat string steps to intent-free step objects', () => {
    expect(combineLegacyPlanSteps(['Add manifest', 'Add script'])).toEqual([
      { description: 'Add manifest' },
      { description: 'Add script' },
    ]);
  });

  it('passes combined step objects through and keeps their own intent', () => {
    expect(combineLegacyPlanSteps([{ description: 'Rename guard', intent: 'own goal' }])).toEqual([
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

  it('returns an empty list for a non-array steps value', () => {
    expect(combineLegacyPlanSteps(undefined)).toEqual([]);
  });
});

describe('coerceLegacyPlanShape', () => {
  it('converts flat string steps to step objects', () => {
    const coerced = coerceLegacyPlanShape({
      action: 'fix',
      steps: ['Rename guard'],
    }) as Record<string, unknown>;

    expect(coerced.steps).toEqual([{ description: 'Rename guard' }]);
  });

  it('returns the payload unchanged when it carries the retired stepIntents field', () => {
    const raw = { action: 'fix', steps: ['a', 'b'], stepIntents: ['goal', null] };

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
