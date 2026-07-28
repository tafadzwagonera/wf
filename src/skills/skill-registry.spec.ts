import inquirer from 'inquirer';
import { KNOWN_SKILLS, registerSkill, resolveSkills, collectQualityRules } from './skill-registry';
import { ConfigurationError } from '../shared/errors/app.error';
import type { SkillDefinition } from './skill.types';

const createMockSkill = (id: string, stages: SkillDefinition['stages'] = ['plan']): SkillDefinition => ({
  id,
  stages,
});

describe('registerSkill', () => {
  afterEach(() => {
    jest.restoreAllMocks();
    KNOWN_SKILLS.clear();
  });

  it('adds the skill to KNOWN_SKILLS', () => {
    const mockSkill = createMockSkill('test-skill');
    registerSkill(mockSkill);
    expect(KNOWN_SKILLS.get('test-skill')).toBe(mockSkill);
  });

  it('throws on duplicate skill ID', () => {
    registerSkill(createMockSkill('duplicate-skill'));
    expect(() => registerSkill(createMockSkill('duplicate-skill'))).toThrow('Skill "duplicate-skill" is already registered.');
  });
});

describe('resolveSkills', () => {
  afterEach(() => {
    jest.restoreAllMocks();
    KNOWN_SKILLS.clear();
  });

  it('returns resolved definitions for valid IDs', async () => {
    const mockSkillA = createMockSkill('skill-a');
    const mockSkillB = createMockSkill('skill-b');
    registerSkill(mockSkillA);
    registerSkill(mockSkillB);

    const result = await resolveSkills(['skill-a', 'skill-b'], { interactive: false });
    expect(result).toEqual([mockSkillA, mockSkillB]);
  });

  it('throws ConfigurationError for unknown ID in non-interactive mode', async () => {
    registerSkill(createMockSkill('known-skill'));

    await expect(resolveSkills(['unknown-skill'], { interactive: false }))
      .rejects.toThrow(ConfigurationError);
  });

  it('throws ConfigurationError with helpful message listing available skills', async () => {
    registerSkill(createMockSkill('available-skill'));

    await expect(resolveSkills(['typo-skill'], { interactive: false }))
      .rejects.toThrow('available-skill');
  });

  it('prompts via inquirer and resolves corrected ID in interactive mode', async () => {
    const mockSkill = createMockSkill('correct-skill');
    registerSkill(mockSkill);
    jest.spyOn(inquirer, 'prompt').mockResolvedValue({ correctedId: 'correct-skill' });

    const result = await resolveSkills(['typo-skill'], { interactive: true });
    expect(result).toEqual([mockSkill]);
    expect(inquirer.prompt).toHaveBeenCalledTimes(1);
  });

  it('drops the skill when user selects Skip in interactive mode', async () => {
    registerSkill(createMockSkill('some-skill'));
    jest.spyOn(inquirer, 'prompt').mockResolvedValue({ correctedId: 'Skip (no skill)' });

    const result = await resolveSkills(['unknown-skill'], { interactive: true });
    expect(result).toEqual([]);
  });

  it('returns empty array when given no IDs', async () => {
    const result = await resolveSkills([], { interactive: false });
    expect(result).toEqual([]);
  });

  it('throws ConfigurationError when skill does not support the requested stage', async () => {
    registerSkill(createMockSkill('plan-only-skill', ['plan']));

    await expect(resolveSkills(['plan-only-skill'], { interactive: false, stage: 'review' }))
      .rejects.toThrow(ConfigurationError);
  });

  it('includes skill ID and supported stages in stage mismatch error', async () => {
    registerSkill(createMockSkill('plan-implement-skill', ['plan', 'implement']));

    await expect(resolveSkills(['plan-implement-skill'], { interactive: false, stage: 'review' }))
      .rejects.toThrow('does not support the "review" stage (supports: plan, implement)');
  });

  it('accepts a skill when it supports the requested stage', async () => {
    const mockSkill = createMockSkill('multi-stage-skill', ['plan', 'implement', 'review']);
    registerSkill(mockSkill);

    const result = await resolveSkills(['multi-stage-skill'], { interactive: false, stage: 'implement' });
    expect(result).toEqual([mockSkill]);
  });

  it('skips stage validation when stage is omitted', async () => {
    const mockSkill = createMockSkill('plan-only', ['plan']);
    registerSkill(mockSkill);

    const result = await resolveSkills(['plan-only'], { interactive: false });
    expect(result).toEqual([mockSkill]);
  });
});

describe('collectQualityRules', () => {
  afterEach(() => {
    jest.restoreAllMocks();
    KNOWN_SKILLS.clear();
  });

  it('returns empty array when no skills have quality rules', () => {
    const skills = [createMockSkill('no-rules-skill')];
    expect(collectQualityRules(skills)).toEqual([]);
  });

  it('merges quality rules from multiple skills', () => {
    const ruleA = { ruleId: 'rule-a', validate: jest.fn().mockReturnValue([]) };
    const ruleB = { ruleId: 'rule-b', validate: jest.fn().mockReturnValue([]) };
    const skillWithRules: SkillDefinition = {
      id: 'skill-with-rules',
      stages: ['plan'],
      getQualityRules: () => [ruleA, ruleB],
    };
    const anotherSkillWithRules: SkillDefinition = {
      id: 'another-skill',
      stages: ['plan'],
      getQualityRules: () => [{ ruleId: 'rule-c', validate: jest.fn().mockReturnValue([]) }],
    };

    const rules = collectQualityRules([skillWithRules, anotherSkillWithRules]);
    expect(rules).toHaveLength(3);
    expect(rules.map(r => r.ruleId)).toEqual(['rule-a', 'rule-b', 'rule-c']);
  });

  it('skips skills without getQualityRules', () => {
    const skillWithRules: SkillDefinition = {
      id: 'has-rules',
      stages: ['plan'],
      getQualityRules: () => [{ ruleId: 'rule-x', validate: jest.fn().mockReturnValue([]) }],
    };
    const skillWithout = createMockSkill('no-rules');

    const rules = collectQualityRules([skillWithRules, skillWithout]);
    expect(rules).toHaveLength(1);
    expect(rules[0].ruleId).toBe('rule-x');
  });
});
