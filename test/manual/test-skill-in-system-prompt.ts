/**
 * Manual smoke test: Skill tool listed in buildSystemPrompt
 *
 * Run: nr test:manual -- test-skill-in-system-prompt
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

let passed = 0;
let failed = 0;

const pass = (message: string): void => {
  console.log(chalk.green(`  \u2713 ${message}`));
  passed += 1;
};

const fail = (message: string, detail?: string): void => {
  console.error(chalk.red(`  \u2717 ${message}${detail ? `\n    → ${detail}` : ''}`));
  failed += 1;
};

const assert = (label: string, condition: boolean, detail?: string): void => {
  if (condition) {
    pass(label);
    return;
  }
  fail(label, detail);
};

function main(): void {
  console.log(chalk.bold.cyan('\n  Skill in buildSystemPrompt smoke test\n'));

  const prompt = buildSystemPrompt({ repoDir: '/tmp/repo' });

  // Test 1: Skill tool entry is present
  console.log(chalk.bold('Test 1: buildSystemPrompt contains Skill tool entry'));
  assert(
    'prompt contains "- Skill(skill, args?): invoke a specialized skill"',
    prompt.includes('- Skill(skill, args?): invoke a specialized skill'),
    `Skill entry not found in prompt`
  );

  // Test 2: Skill appears in the Available tools section
  console.log(chalk.bold('\nTest 2: Skill appears in the Available tools section'));
  const toolsSection = prompt.split('Available tools:\n')[1]?.split('\n\nRules:')[0] ?? '';
  assert(
    'Skill line is between "Available tools:" and "Rules:"',
    toolsSection.includes('- Skill(skill, args?)'),
    `Tools section: ${toolsSection.substring(0, 200)}`
  );

  // Test 3: Skill entry includes signature and description
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

  // Test 4: Total tool count is 7
  console.log(chalk.bold('\nTest 4: Available tools section lists exactly 7 tools'));
  const toolLines = toolsSection.split('\n').filter(l => l.startsWith('- '));
  const toolNames = toolLines.map(l => (/^- (\w+)\(/.exec(l))?.[1]).filter(Boolean);
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

  // Summary
  console.log(chalk.bold('\nSummary'));
  console.log(`  Passed: ${passed}`);
  console.log(`  Failed: ${failed}`);

  if (failed > 0) process.exit(1);
}

main();
