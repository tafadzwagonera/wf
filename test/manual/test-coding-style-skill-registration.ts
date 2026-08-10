/**
 * Manual smoke test: coding-style skill registers and resolves for implement stage
 *
 * Run: nr test:manual -- test-coding-style-skill-registration
 *
 * Verifies:
 *   1. AppModule bootstraps without error
 *   2. KNOWN_SKILLS contains 'coding-style' after bootstrap
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
import { KNOWN_SKILLS, resolveSkills } from '../../src/skills/skill-registry';
import { buildSkillPromptFragment } from '../../src/skills/skill-content';
import { ConfigurationError } from '../../src/shared/errors/app.error';
import chalk from 'chalk';

let passed = 0;
let failed = 0;

const pass = (message: string): void => {
  console.log(chalk.green(`  \u2713 ${message}`));
  passed += 1;
};

const fail = (message: string, detail?: string): void => {
  console.error(chalk.red(`  \u2717 ${message}${detail ? `\n    \u2192 ${detail}` : ''}`));
  failed += 1;
};

const assert = (label: string, condition: boolean, detail?: string): void => {
  if (condition) {
    pass(label);
    return;
  }
  fail(label, detail);
};

async function main(): Promise<void> {
  console.log(chalk.bold.cyan('\n  coding-style skill registration smoke test\n'));

  // Test 1: Bootstrap
  console.log(chalk.bold('Test 1: AppModule bootstraps'));
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error'] });
  assert('bootstrap succeeds', !!app);

  try {
    // Test 2: KNOWN_SKILLS contains coding-style
    console.log(chalk.bold('\nTest 2: KNOWN_SKILLS contains coding-style'));
    assert('KNOWN_SKILLS.has(coding-style)', KNOWN_SKILLS.has('coding-style'));

    // Test 3: Stages deep-equals ['implement']
    console.log(chalk.bold('\nTest 3: coding-style stages'));
    const skill = KNOWN_SKILLS.get('coding-style');
    assert(
      'stages is [implement]',
      JSON.stringify(skill?.stages) === JSON.stringify(['implement']),
      `got: ${JSON.stringify(skill?.stages)}`
    );

    // Test 4: resolveSkills accepts for implement
    console.log(chalk.bold('\nTest 4: resolveSkills accepts for implement stage'));
    const resolved = await resolveSkills(['coding-style'], { interactive: false, stage: 'implement' });
    assert('resolves to single element', resolved.length === 1);
    assert('resolved id is coding-style', resolved[0]?.id === 'coding-style');

    // Test 5: resolveSkills rejects for plan
    console.log(chalk.bold('\nTest 5: resolveSkills rejects for plan stage'));
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

    // Test 6: resolveSkills rejects for review
    console.log(chalk.bold('\nTest 6: resolveSkills rejects for review stage'));
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

    // Test 7: buildSkillPromptFragment returns content
    console.log(chalk.bold('\nTest 7: buildSkillPromptFragment returns skill content'));
    const fragment = await buildSkillPromptFragment(['coding-style']);
    assert('fragment contains "## Skill: coding-style"', fragment.includes('## Skill: coding-style'));
    assert('fragment contains SKILL.md content', fragment.includes('name: coding-style'));
  } finally {
    await app.close();
  }

  // Summary
  console.log(chalk.bold('\nSummary'));
  console.log(`  Passed: ${passed}`);
  console.log(`  Failed: ${failed}`);

  if (failed > 0) process.exit(1);
}

main();
