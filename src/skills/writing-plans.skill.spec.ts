import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { planModelOutputSchema } from '../common/schemas/ai.schema';
import { knownSkills } from './skill-registry';

// Import the skill module to trigger registration
import './writing-plans.skill';

describe('writing-plans skill', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('is registered in knownSkills', () => {
    expect(knownSkills.has('writing-plans')).toBe(true);
  });

  it('has stages: plan', () => {
    expect(knownSkills.get('writing-plans')?.stages).toEqual(['plan']);
  });
});

describe('writing-plans skill: no-placeholders quality rule', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  const getRule = () => {
    const skill = knownSkills.get('writing-plans');
    const rules = skill?.getQualityRules?.() ?? [];
    const rule = rules.find(r => r.ruleId === 'no-placeholders');
    if (!rule) throw new Error('no-placeholders rule not found in writing-plans skill');
    return rule;
  };

  it('returns empty array for a clean plan with no placeholders', () => {
    const rule = getRule();
    const violations = rule.validate({ steps: [{ description: 'Implement the authentication flow.' }, { description: 'Add unit tests.' }] });
    expect(violations).toEqual([]);
  });

  it('detects TBD in a step', () => {
    const rule = getRule();
    const violations = rule.validate({ steps: [{ description: 'TBD' }] });
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain('Step 1');
    expect(violations[0]).toContain('TBD');
  });

  it('detects TODO in a step', () => {
    const rule = getRule();
    const violations = rule.validate({ steps: [{ description: 'TODO: add implementation' }] });
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain('Step 1');
  });

  it('detects "implement later" in a step', () => {
    const rule = getRule();
    const violations = rule.validate({ steps: [{ description: 'We will implement later this part.' }] });
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain('Step 1');
  });

  it('detects "fill in details" in a step', () => {
    const rule = getRule();
    const violations = rule.validate({ steps: [{ description: 'fill in details here' }] });
    expect(violations).toHaveLength(1);
  });

  it('detects "fill in detail" (singular) in a step', () => {
    const rule = getRule();
    const violations = rule.validate({ steps: [{ description: 'fill in detail for the implementation' }] });
    expect(violations).toHaveLength(1);
  });

  it('detects "similar to task" in a step', () => {
    const rule = getRule();
    const violations = rule.validate({ steps: [{ description: 'Similar to task 3, add error handling.' }] });
    expect(violations).toHaveLength(1);
  });

  it('detects "similar to step" in a step', () => {
    const rule = getRule();
    const violations = rule.validate({ steps: [{ description: 'Similar to step 2, configure the client.' }] });
    expect(violations).toHaveLength(1);
  });

  it('is case-insensitive', () => {
    const rule = getRule();
    const violations = rule.validate({ steps: [{ description: 'tbd' }, { description: 'todo: do this' }] });
    expect(violations).toHaveLength(2);
  });

  it('includes the step index (1-based) in violation messages', () => {
    const rule = getRule();
    const violations = rule.validate({
      steps: [
        { description: 'Clean step' },
        { description: 'TBD' },
        { description: 'Another clean step' },
        { description: 'TODO: implement' },
      ],
    });
    expect(violations).toHaveLength(2);
    expect(violations[0]).toContain('Step 2');
    expect(violations[1]).toContain('Step 4');
  });

  it('returns empty array when steps is undefined', () => {
    const rule = getRule();
    const violations = rule.validate({});
    expect(violations).toEqual([]);
  });

  it('returns empty array when steps is empty', () => {
    const rule = getRule();
    const violations = rule.validate({ steps: [] });
    expect(violations).toEqual([]);
  });
});

describe('writing-plans SKILL.md example', () => {
  const skillMd = readFileSync(path.join(__dirname, 'content', 'writing-plans', 'SKILL.md'), 'utf-8');

  it('contains a JSON example accepted by planModelOutputSchema', () => {
    const example = /```json\n([\s\S]*?)\n```/.exec(skillMd)?.[1] ?? '';
    expect(() => planModelOutputSchema.parse(JSON.parse(example))).not.toThrow();
  });

  it('instructs the planner to emit per-step intent only for literal-prescribing steps', () => {
    expect(skillMd).toContain('Add an `intent` only when the step prescribes a literal');
    expect(skillMd).toContain('(a call chain, signature, regex, or test name)');
    expect(skillMd).toContain('checkable from the diff');
    expect(skillMd).toContain('omit it for every other step');
  });

  it('does not claim verification.targeted is required', () => {
    expect(skillMd).not.toMatch(/`verification\.targeted`\s*—\s*\*\*required\*\*/);
  });
});
