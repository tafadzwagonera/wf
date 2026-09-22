/**
 * Manual smoke test: Skill tool listed in buildSystemPrompt
 *
 * Run: nr test:manual skill-in-system-prompt.smoke.ts
 *
 * Verifies:
 *   1. buildSystemPrompt output contains the Skill tool entry
 *   2. Skill appears in the "Available tools" section, not elsewhere
 *   3. Skill tool entry includes the expected signature and description
 *   4. Total available tool count is 7 (Read, Write, Edit, Glob, Grep, Bash, Skill)
 *
 * @returns void
 */
import chalk from 'chalk';
import { buildSystemPrompt } from '../../src/integrations/ai/adapters/anthropic-agent.adapter';

import { createReporter, summarise } from './support/reporter';

const { counts, pass, fail } = createReporter();

const assert = (label: string, condition: boolean, detail?: string): void => {
  if (condition) {
    pass(label);
    return;
  }
  fail(label, detail);
};

function checkSkillEntryPresent(prompt: string): void {
  console.log(chalk.bold('Test 1: buildSystemPrompt contains Skill tool entry'));
  assert(
    'prompt contains "- Skill(skill, args?): invoke a specialized skill"',
    prompt.includes('- Skill(skill, args?): invoke a specialized skill'),
    `Skill entry not found in prompt`
  );
}

function checkSkillInToolsSection(prompt: string): void {
  console.log(chalk.bold('\nTest 2: Skill appears in the Available tools section'));
  const toolsSection = prompt.split('Available tools:\n')[1]?.split('\n\nRules:')[0] ?? '';
  assert(
    'Skill line is between "Available tools:" and "Rules:"',
    toolsSection.includes('- Skill(skill, args?)'),
    `Tools section: ${toolsSection.substring(0, 200)}`
  );
}

function checkSkillSignatureAndDescription(prompt: string): void {
  console.log(chalk.bold('\nTest 3: Skill entry has expected signature and description'));
  const skillLine = prompt.split('\n').find(l => l.includes('Skill(skill, args?)'));
  assert(
    'Skill line mentions "specialized skill"',
    !!skillLine && skillLine.includes('specialized skill'),
    `Got: ${skillLine}`
  );
  assert(
    'Skill line mentions example skills (plan-quality, executing-plans)',
    !!skillLine && skillLine.includes('plan-quality') && skillLine.includes('executing-plans'),
    `Got: ${skillLine}`
  );
}

function extractToolNames(prompt: string): string[] {
  const toolsSection = prompt.split('Available tools:\n')[1]?.split('\n\nRules:')[0] ?? '';
  const toolLines = toolsSection.split('\n').filter(l => l.startsWith('- '));
  return toolLines.map(l => (/^- (\w+)\(/.exec(l))?.[1]).filter(Boolean) as string[];
}

function checkToolCount(prompt: string): void {
  console.log(chalk.bold('\nTest 4: Available tools section lists exactly 7 tools'));
  const toolNames = extractToolNames(prompt);
  assert(
    `7 tools listed: ${toolNames.join(', ')}`,
    toolNames.length === 7,
    `Expected 7 tools, got ${toolNames.length}: ${toolNames.join(', ')}`
  );
  assert(
    'tool list includes Read, Write, Edit, Glob, Grep, Bash, Skill',
    ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash', 'Skill'].every(t => toolNames.includes(t)),
    `Missing tools from: ${toolNames.join(', ')}`
  );
}

function main(): void {
  console.log(chalk.bold.cyan('\n  Skill in buildSystemPrompt smoke test\n'));
  const prompt = buildSystemPrompt({ repoDir: '/tmp/repo' });
  checkSkillEntryPresent(prompt);
  checkSkillInToolsSection(prompt);
  checkSkillSignatureAndDescription(prompt);
  checkToolCount(prompt);
  summarise(counts);
}

main();
