/**
 * Manual smoke test: system prompt contains no task-specific content after behavioral split
 *
 * Run: nr test:manual system-prompt-isolation.smoke.ts
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
import { createReporter, summarise } from './support/reporter';

const { counts, pass, fail } = createReporter();

const assert = (label: string, condition: boolean): void =>
  condition ? pass(label) : fail(label);

function loadAdapterSources(adaptersDir: string): { openaiSource: string; cliSource: string } {
  return {
    openaiSource: fs.readFileSync(path.join(adaptersDir, 'openai-agent.adapter.ts'), 'utf8'),
    cliSource: fs.readFileSync(path.join(adaptersDir, 'claude-cli.adapter.ts'), 'utf8'),
  };
}

function checkSystemPromptContents(prompt: string): void {
  assert('contains role identity', prompt.includes('You are an expert software engineer'));
  assert('contains repository directory', prompt.includes('Repository directory: /tmp/test-repo'));
  assert('contains scoping rules', prompt.includes('Writes must stay scoped to the primary repository'));
  assert('contains summary template', prompt.includes('### What I changed'));
  assert('contains Skill tool', prompt.includes('Skill(skill, args?)'));
}

function checkSystemPromptExclusions(prompt: string): void {
  assert('does NOT contain Ticket key:', !prompt.includes('Ticket key:'));
  assert('does NOT contain Plan summary:', !prompt.includes('Plan summary:'));
  assert('does NOT contain Plan steps:', !prompt.includes('Plan steps:'));
  assert('does NOT contain Files to implement:', !prompt.includes('Files to implement:'));
  assert('does NOT contain Verification commands:', !prompt.includes('Verification commands:'));
  assert('does NOT contain Risks and guardrails:', !prompt.includes('Risks and guardrails:'));
  assert('does NOT contain Risks and considerations:', !prompt.includes('Risks and considerations:'));
}

function checkOpenAiAdapter(src: string): void {
  assert('OpenAI: buildRisksBlock removed', !src.includes('const buildRisksBlock'));
  assert('OpenAI: buildPlanSection removed', !src.includes('const buildPlanSection'));
  assert('OpenAI: buildSystemPrompt calls buildBehavioralContext', src.includes('buildBehavioralContext(p.repoDir)'));
  assert('OpenAI: SystemPromptParams has only repoDir and conventionsSection',
    /type SystemPromptParams\s*=\s*\{[^}]*repoDir:\s*string/.test(src)
    && !/type SystemPromptParams\s*=\s*\{[^}]*ticketKey/.test(src));
}

function checkCliAdapter(src: string): void {
  assert('CLI: imports buildSystemPrompt from anthropic-agent.adapter',
    /import \{[^}]*\bbuildSystemPrompt\b[^}]*\} from '\.\/anthropic-agent\.adapter'/.test(src));
}

async function main(): Promise<void> {
  const adaptersDir = path.join(__dirname, '..', '..', 'src', 'integrations', 'ai', 'adapters');
  const { openaiSource, cliSource } = loadAdapterSources(adaptersDir);
  const prompt = buildSystemPrompt({ repoDir: '/tmp/test-repo' });
  console.log(chalk.bold('\n  Live buildSystemPrompt output assertions\n'));
  checkSystemPromptContents(prompt);
  checkSystemPromptExclusions(prompt);
  console.log(chalk.bold('\n  OpenAI adapter structural assertions\n'));
  checkOpenAiAdapter(openaiSource);
  console.log(chalk.bold('\n  CLI adapter delegation assertion\n'));
  checkCliAdapter(cliSource);
  summarise(counts);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
