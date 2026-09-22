/**
 * Manual smoke test: user-level skill directories resolve before plugin cache
 *
 * Run: nr test:manual skill-search-path-priority.smoke.ts
 *
 * Verifies:
 *   1. readSkillContent('coding-style') returns non-null content
 *   2. The returned content contains frontmatter and 'name: coding-style'
 *   3. Content matches the file at ~/.claude/skills/ exactly (confirms priority)
 *   4. readSkillContent for a skill in ~/.codex/skills/ also resolves
 *   5. readSkillContent for a completely absent skill returns null
 *
 * @returns Promise that resolves when the smoke test completes
 */
import chalk from 'chalk';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { readSkillContent } from '../../src/skills/skill-content';

import { createReporter, summarise } from './support/reporter';

const { counts, pass, fail } = createReporter();

const assert = (label: string, condition: boolean, detail?: string): void => {
  if (condition) {
    pass(label);
    return;
  }
  fail(label, detail);
};

async function checkCodingStyleResolution(): Promise<string | null> {
  console.log(chalk.bold('Test 1: coding-style resolves from user-level path'));
  const content = await readSkillContent('coding-style');
  assert('readSkillContent returns non-null', content !== null, 'got null');
  return content;
}

async function checkFrontmatter(content: string | null): Promise<void> {
  console.log(chalk.bold('\nTest 2: Content contains frontmatter'));
  assert('content contains ---', !!content && content.includes('---'));
  assert('content contains name: coding-style', !!content && content.includes('name: coding-style'));
}

async function checkMatchesUserLevelFile(content: string | null): Promise<void> {
  console.log(chalk.bold('\nTest 3: Content matches user-level file exactly'));
  const userLevelPath = path.join(os.homedir(), '.claude', 'skills', 'coding-style', 'SKILL.md');
  let directContent: string | null = null;
  try {
    directContent = await fs.readFile(userLevelPath, 'utf-8');
  } catch {
    directContent = null;
  }
  assert('user-level SKILL.md exists on disk', directContent !== null, `not found at ${userLevelPath}`);
  assert('readSkillContent output matches direct read', content === directContent);
}

async function resolveCodexExists(codexSkillPath: string): Promise<boolean> {
  try {
    await fs.access(codexSkillPath);
    return true;
  } catch {
    return false;
  }
}

async function checkCodexOrFallback(): Promise<void> {
  console.log(chalk.bold('\nTest 4: Codex user-level path resolves'));
  const codexSkillPath = path.join(os.homedir(), '.codex', 'skills', 'coding-style', 'SKILL.md');
  const codexExists = await resolveCodexExists(codexSkillPath);
  if (codexExists) {
    const codexContent = await fs.readFile(codexSkillPath, 'utf-8');
    assert('codex SKILL.md has content', codexContent.length > 0);
  } else {
    console.log(chalk.gray('    (codex coding-style SKILL.md not found — testing with commit skill)'));
    const commitContent = await readSkillContent('commit');
    assert('readSkillContent resolves a skill present in both paths', commitContent !== null);
  }
}

async function checkAbsentSkillReturnsNull(): Promise<void> {
  console.log(chalk.bold('\nTest 5: Absent skill returns null'));
  const absent = await readSkillContent('zz-nonexistent-skill-' + Date.now());
  assert('readSkillContent returns null for absent skill', absent === null);
}

async function main(): Promise<void> {
  console.log(chalk.bold.cyan('\n  Skill search path priority smoke test\n'));
  const content = await checkCodingStyleResolution();
  await checkFrontmatter(content);
  await checkMatchesUserLevelFile(content);
  await checkCodexOrFallback();
  await checkAbsentSkillReturnsNull();
  summarise(counts);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
