/**
 * Manual smoke test: frontend-design-nuxt is registered; frontend-design and receiving-code-review are absent
 *
 * Run: nr test:manual frontend-design-nuxt-registration.smoke
 *
 * Verifies:
 *   1. AppModule bootstraps without error
 *   2. knownSkills contains 'frontend-design-nuxt' after bootstrap
 *   3. frontend-design-nuxt stages include both 'plan' and 'implement'
 *   4. knownSkills does not contain 'frontend-design' (renamed)
 *   5. knownSkills does not contain 'receiving-code-review' (removed)
 *   6. resolveSkills resolves frontend-design-nuxt for plan stage
 *   7. resolveSkills resolves frontend-design-nuxt for implement stage
 *   8. resolveSkills throws for review stage (skill not active there)
 *
 * @returns Promise that resolves when the smoke test completes
 */
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../../src/app.module';
import { knownSkills, resolveSkills } from '../../src/skills/skill-registry';
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

function checkFrontendDesignNuxtStages(): void {
  const skill = knownSkills.get('frontend-design-nuxt');
  const detail = `stages: ${JSON.stringify(skill?.stages)}`;
  assert('frontend-design-nuxt stages include plan', skill?.stages.includes('plan') === true, detail);
  assert('frontend-design-nuxt stages include implement', skill?.stages.includes('implement') === true, detail);
}

function checkRegistration(): void {
  console.log(chalk.bold('Test 1-5: Skill registration state'));
  assert('knownSkills has frontend-design-nuxt', knownSkills.has('frontend-design-nuxt'));
  checkFrontendDesignNuxtStages();
  assert('frontend-design absent from knownSkills', knownSkills.has('frontend-design') === false);
  assert('receiving-code-review absent from knownSkills', knownSkills.has('receiving-code-review') === false);
}

async function checkResolveForPlan(): Promise<void> {
  console.log(chalk.bold('\nTest 6: resolves for plan stage'));
  const resolved = await resolveSkills(['frontend-design-nuxt'], { interactive: false, stage: 'plan' });
  assert('resolved list has one entry', resolved.length === 1);
  assert('resolved id is frontend-design-nuxt', resolved[0]?.id === 'frontend-design-nuxt');
}

async function checkResolveForImplement(): Promise<void> {
  console.log(chalk.bold('\nTest 7: resolves for implement stage'));
  const resolved = await resolveSkills(['frontend-design-nuxt'], { interactive: false, stage: 'implement' });
  assert('resolved list has one entry', resolved.length === 1);
}

async function checkRejectsForReview(): Promise<void> {
  console.log(chalk.bold('\nTest 8: throws for review stage'));
  let caughtError: Error | null = null;
  try {
    await resolveSkills(['frontend-design-nuxt'], { interactive: false, stage: 'review' });
  } catch (err) {
    caughtError = err instanceof Error ? err : null;
  }
  assert('throws for review stage', caughtError !== null);
  assert(
    'error message references review stage',
    caughtError?.message.includes('review') === true,
    `got: ${caughtError?.message}`
  );
}

async function main(): Promise<void> {
  console.log(chalk.bold.cyan('\n  frontend-design-nuxt registration smoke test\n'));
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error'] });
  try {
    checkRegistration();
    await checkResolveForPlan();
    await checkResolveForImplement();
    await checkRejectsForReview();
  } finally {
    await app.close();
  }
  summarise(counts);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
