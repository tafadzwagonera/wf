import { registerSkill } from './skill-registry';

const PLACEHOLDER_PATTERN = /\b(TBD|TODO|implement later|fill in details?|similar to (task|step))\b/i;

registerSkill({
  id: 'writing-plans',
  stages: ['plan'],
  getQualityRules: () => [
    {
      ruleId: 'no-placeholders',
      validate(plan) {
        const steps = Array.isArray(plan.steps) ? plan.steps : [];
        const violations: string[] = [];
        for (const [index, step] of steps.entries()) {
          if (PLACEHOLDER_PATTERN.test(step)) {
            violations.push(`Step ${index + 1} contains a placeholder: "${step}"`);
          }
        }
        return violations;
      },
    },
  ],
});
