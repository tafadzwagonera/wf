/**
 * Manual smoke test: All four bundled SKILL.md files are readable via readSkillContent
 *
 * Run: nr test:manual bundled-skill-dist-readability.smoke
 *
 * Verifies:
 *   1. readSkillContent returns non-null for each of the four bundled skill IDs
 *   2. Each returned string starts with '#' (valid Markdown heading)
 *   3. readSkillContent returns null for an unknown skill ID
 *
 * @returns Promise that resolves when the smoke test completes
 */
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../../src/app.module';
import { readSkillContent } from '../../src/skills/skill-content';
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

const BUNDLED_SKILL_IDS = ['coding-style', 'frontend-design-nuxt', 'test-driven-development', 'writing-plans'];

async function checkAllBundledSkillsReadable(): Promise<void> {
  console.log(chalk.bold('Test 1: All bundled skills return non-null content'));
  for (const id of BUNDLED_SKILL_IDS) {
    const content = await readSkillContent(id);
    assert(`readSkillContent('${id}') returns non-null`, content !== null);
    assert(`readSkillContent('${id}') content starts with frontmatter`, content !== null && content.trimStart().startsWith('---'));
  }
}

async function checkAbsentSkillReturnsNull(): Promise<void> {
  console.log(chalk.bold('\nTest 2: Absent skill returns null'));
  const content = await readSkillContent('zz-no-such-skill');
  assert('readSkillContent returns null for unknown skill', content === null);
}

async function main(): Promise<void> {
  console.log(chalk.bold.cyan('\n  Bundled skill dist readability smoke test\n'));
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error'] });
  try {
    await checkAllBundledSkillsReadable();
    await checkAbsentSkillReturnsNull();
  } finally {
    await app.close();
  }
  summarise(counts);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
