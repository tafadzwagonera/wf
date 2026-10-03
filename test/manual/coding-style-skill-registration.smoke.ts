/**
 * Manual smoke test: coding-style skill registers and resolves for implement stage
 *
 * Run: nr test:manual coding-style-skill-registration.smoke.ts
 *
 * Verifies:
 *   1. AppModule bootstraps without error
 *   2. knownSkills contains 'coding-style' after bootstrap
 *   3. coding-style stages deep-equals ['implement']
 *   4. resolveSkills accepts coding-style for implement stage
 *   5. resolveSkills rejects coding-style for plan stage
 *   6. resolveSkills rejects coding-style for review stage
 *   7. buildSkillPromptFragment returns content with coding-style header
 *
 * @returns Promise that resolves when the smoke test completes
 */
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../../src/app.module';
import { knownSkills, resolveSkills } from '../../src/skills/skill-registry';
import { buildSkillPromptFragment } from '../../src/skills/skill-content';
import { ConfigurationError } from '../../src/shared/errors/app.error';
import chalk from 'chalk';
import { createReporter, summarise } from './support/reporter';

const { counts, pass, fail } = createReporter();

const assert = (label: string, condition: boolean, detail?: string): void => {
  if (condition) {
    pass(label);
    return;
  }
  fail(label, detail);
};

function checkKnownSkillsRegistered(): void {
  assert('knownSkills.has(coding-style)', knownSkills.has('coding-style'));
  const skill = knownSkills.get('coding-style');
  assert(
    'stages is [implement]',
    JSON.stringify(skill?.stages) === JSON.stringify(['implement']),
    `got: ${JSON.stringify(skill?.stages)}`
  );
}

async function checkResolveForImplement(): Promise<void> {
  const resolved = await resolveSkills(['coding-style'], { interactive: false, stage: 'implement' });
  assert('resolves to single element', resolved.length === 1);
  assert('resolved id is coding-style', resolved[0]?.id === 'coding-style');
}

async function checkRejectsForPlan(): Promise<void> {
  let planError: Error | null = null;
  try {
    await resolveSkills(['coding-style'], { interactive: false, stage: 'plan' });
  } catch (err) {
    planError = err instanceof Error ? err : null;
  }
  assert('throws ConfigurationError', planError instanceof ConfigurationError);
  assert(
    'message contains "plan" stage',
    !!planError?.message.includes('does not support the "plan" stage'),
    `got: ${planError?.message}`
  );
}

async function checkRejectsForReview(): Promise<void> {
  let reviewError: Error | null = null;
  try {
    await resolveSkills(['coding-style'], { interactive: false, stage: 'review' });
  } catch (err) {
    reviewError = err instanceof Error ? err : null;
  }
  assert('throws ConfigurationError', reviewError instanceof ConfigurationError);
  assert(
    'message contains "review" stage',
    !!reviewError?.message.includes('does not support the "review" stage'),
    `got: ${reviewError?.message}`
  );
}

async function checkSkillPromptFragment(): Promise<void> {
  const fragment = await buildSkillPromptFragment(['coding-style'], 'smoke-test', s => s);
  assert('fragment contains "## Skill: coding-style"', fragment.includes('## Skill: coding-style'));
  assert('fragment contains SKILL.md content', fragment.includes('name: coding-style'));
}

async function main(): Promise<void> {
  console.log(chalk.bold.cyan('\n  coding-style skill registration smoke test\n'));
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error'] });
  try {
    assert('bootstrap succeeds', !!app);
    checkKnownSkillsRegistered();
    await checkResolveForImplement();
    await checkRejectsForPlan();
    await checkRejectsForReview();
    await checkSkillPromptFragment();
  } finally {
    await app.close();
  }
  summarise(counts);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
