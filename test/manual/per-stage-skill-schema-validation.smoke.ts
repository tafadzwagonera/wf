/**
 * Manual smoke test: per-stage skill schema validation rejects invalid skill names
 *
 * Run: nr test:manual per-stage-skill-schema-validation.smoke.ts
 *
 * Verifies:
 *   1-3. Valid skill names pass for implement, plan, and review stages
 *   4-6. Invalid skill names fail for implement, plan, and review stages
 *   7.   Empty skills arrays succeed for all stages
 *   8.   Omitted skills succeed for all stages
 *
 * @returns void
 */
import chalk from 'chalk';
import {
  wfConfigSchema,
  wfImplementSkillNameSchema,
  wfPlanSkillNameSchema,
  wfReviewSkillNameSchema,
} from '../../src/shared/schemas/config.schema';
import { createReporter, summarise } from './support/reporter';

const { counts, pass, fail } = createReporter();

const assert = (label: string, condition: boolean, detail?: string): void => {
  if (condition) {
    pass(label);
    return;
  }
  fail(label, detail);
};

const baseConfig = (stagesOverride: Record<string, unknown>) => ({
  ai: [{ provider: 'anthropic' as const, apiKey: 'k', model: 'claude-sonnet-4-6' }],
  stages: stagesOverride,
});

function checkValidImplementSkills(): void {
  console.log(chalk.bold('Test 1: Valid implement skills pass'));
  const result = wfConfigSchema.safeParse(baseConfig({ implement: { provider: 'anthropic', skills: ['coding-style', 'test-driven-development'] } }));
  assert('safeParse succeeds', result.success, result.success ? undefined : JSON.stringify(result.error.issues[0]));
}

function checkValidPlanSkills(): void {
  console.log(chalk.bold('\nTest 2: Valid plan skills pass'));
  const result = wfConfigSchema.safeParse(baseConfig({ plan: { provider: 'anthropic', skills: ['frontend-design', 'test-driven-development', 'writing-plans'] } }));
  assert('safeParse succeeds', result.success, result.success ? undefined : JSON.stringify(result.error.issues[0]));
}

function checkValidReviewSkills(): void {
  console.log(chalk.bold('\nTest 3: Valid review skills pass'));
  const result = wfConfigSchema.safeParse(baseConfig({ review: { provider: 'anthropic', skills: ['receiving-code-review'] } }));
  assert('safeParse succeeds', result.success, result.success ? undefined : JSON.stringify(result.error.issues[0]));
}

function checkInvalidImplementSkill(): void {
  console.log(chalk.bold('\nTest 4: Invalid implement skill rejected'));
  const result = wfConfigSchema.safeParse(baseConfig({ implement: { provider: 'anthropic', skills: ['writing-plans'] } }));
  assert('safeParse fails', !result.success);
  if (!result.success) {
    const msg = result.error.issues[0]?.message ?? '';
    assert('error mentions invalid option', msg.includes('Invalid') && msg.includes('option'), `got: ${msg}`);
  }
}

function checkInvalidPlanSkill(): void {
  console.log(chalk.bold('\nTest 5: Invalid plan skill rejected'));
  const result = wfConfigSchema.safeParse(baseConfig({ plan: { provider: 'anthropic', skills: ['coding-style'] } }));
  assert('safeParse fails', !result.success);
}

function checkInvalidReviewSkill(): void {
  console.log(chalk.bold('\nTest 6: Invalid review skill rejected'));
  const result = wfConfigSchema.safeParse(baseConfig({ review: { provider: 'anthropic', skills: ['test-driven-development'] } }));
  assert('safeParse fails', !result.success);
}

function checkEmptySkillsArrays(): void {
  console.log(chalk.bold('\nTest 7: Empty skills arrays pass'));
  const result = wfConfigSchema.safeParse(baseConfig({ implement: { provider: 'anthropic', skills: [] }, plan: { provider: 'anthropic', skills: [] }, review: { provider: 'anthropic', skills: [] } }));
  assert('safeParse succeeds with empty arrays', result.success);
}

function checkOmittedSkills(): void {
  console.log(chalk.bold('\nTest 8: Omitted skills pass'));
  const result = wfConfigSchema.safeParse(baseConfig({ implement: { provider: 'anthropic' }, plan: { provider: 'anthropic' }, review: { provider: 'anthropic' } }));
  assert('safeParse succeeds without skills', result.success);
}

function checkEnumSchemas(): void {
  console.log(chalk.bold('\nTest 9: Enum schemas contain expected values'));
  assert('implement enum has coding-style', wfImplementSkillNameSchema.options.includes('coding-style'));
  assert('implement enum has frontend-design', wfImplementSkillNameSchema.options.includes('frontend-design'));
  assert('plan enum has writing-plans', wfPlanSkillNameSchema.options.includes('writing-plans'));
  assert('review enum has receiving-code-review', wfReviewSkillNameSchema.options.includes('receiving-code-review'));
  assert('plan enum does NOT have coding-style', !(wfPlanSkillNameSchema.options as string[]).includes('coding-style'));
  assert('review enum does NOT have writing-plans', !(wfReviewSkillNameSchema.options as string[]).includes('writing-plans'));
}

function main(): void {
  console.log(chalk.bold.cyan('\n  Per-stage skill schema validation smoke test\n'));
  checkValidImplementSkills();
  checkValidPlanSkills();
  checkValidReviewSkills();
  checkInvalidImplementSkill();
  checkInvalidPlanSkill();
  checkInvalidReviewSkill();
  checkEmptySkillsArrays();
  checkOmittedSkills();
  checkEnumSchemas();
  summarise(counts);
}

main();
