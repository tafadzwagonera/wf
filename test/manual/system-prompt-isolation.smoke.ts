/**
 * Manual smoke test: system prompt contains no task-specific content after behavioral split
 *
 * Run: nr test:manual -- test-system-prompt-isolation
 *
 * Verifies:
 *   1. buildSystemPrompt output contains role identity and repo directory.
 *   2. buildSystemPrompt output contains scoping rules and summary template.
 *   3. buildSystemPrompt output does NOT contain any task-specific fields.
 *   4. OpenAI adapter removed buildRisksBlock and buildPlanSection.
 *   5. OpenAI adapter buildSystemPrompt calls buildBehavioralContext.
 *   6. CLI adapter delegates to Anthropic buildSystemPrompt.
 *
 * @returns Promise that resolves when the smoke test completes
 */
import chalk from 'chalk';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { buildSystemPrompt } from '../../src/integrations/ai/adapters/anthropic-agent.adapter';

let passed = 0;
let failed = 0;

const assert = (label: string, condition: boolean): void => {
  if (condition) {
    console.log(chalk.green(`  ✓ ${label}`));
    passed++;
  } else {
    console.log(chalk.red(`  ✗ ${label}`));
    failed++;
  }
};

async function main(): Promise<void> {
  const adaptersDir = path.join(__dirname, '..', '..', 'src', 'integrations', 'ai', 'adapters');
  const openaiSource = fs.readFileSync(path.join(adaptersDir, 'openai-agent.adapter.ts'), 'utf8');
  const cliSource = fs.readFileSync(path.join(adaptersDir, 'claude-cli.adapter.ts'), 'utf8');

  const prompt = buildSystemPrompt({ repoDir: '/tmp/test-repo' });

  console.log(chalk.bold('\n  Live buildSystemPrompt output assertions\n'));

  assert('contains role identity', prompt.includes('You are an expert software engineer'));
  assert('contains repository directory', prompt.includes('Repository directory: /tmp/test-repo'));
  assert('contains scoping rules', prompt.includes('Writes must stay scoped to the primary repository'));
  assert('contains summary template', prompt.includes('### What I changed'));
  assert('contains Skill tool', prompt.includes('Skill(skill, args?)'));

  assert('does NOT contain Ticket key:', !prompt.includes('Ticket key:'));
  assert('does NOT contain Plan summary:', !prompt.includes('Plan summary:'));
  assert('does NOT contain Plan steps:', !prompt.includes('Plan steps:'));
  assert('does NOT contain Files to implement:', !prompt.includes('Files to implement:'));
  assert('does NOT contain Verification commands:', !prompt.includes('Verification commands:'));
  assert('does NOT contain Risks and guardrails:', !prompt.includes('Risks and guardrails:'));
  assert('does NOT contain Risks and considerations:', !prompt.includes('Risks and considerations:'));

  console.log(chalk.bold('\n  OpenAI adapter structural assertions\n'));

  assert('OpenAI: buildRisksBlock removed', !openaiSource.includes('const buildRisksBlock'));
  assert('OpenAI: buildPlanSection removed', !openaiSource.includes('const buildPlanSection'));
  assert('OpenAI: buildSystemPrompt calls buildBehavioralContext', openaiSource.includes('buildBehavioralContext(p.repoDir)'));
  assert('OpenAI: SystemPromptParams has only repoDir and conventionsSection',
    /type SystemPromptParams\s*=\s*\{[^}]*repoDir:\s*string/.test(openaiSource)
    && !/type SystemPromptParams\s*=\s*\{[^}]*ticketKey/.test(openaiSource));

  console.log(chalk.bold('\n  CLI adapter delegation assertion\n'));

  assert('CLI: imports buildSystemPrompt from anthropic-agent.adapter',
    cliSource.includes('import { buildSystemPrompt') && cliSource.includes('from \'./anthropic-agent.adapter\''));

  console.log(chalk.bold(`\nResults: ${passed} passed, ${failed} failed\n`));
  if (failed > 0) process.exit(1);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
