/**
 * Manual smoke test: Skill tool in CLI allowedTools
 *
 * Run: nr test:manual cli-skill-tool-allowlist.smoke.ts
 *
 * Verifies:
 *   1. IMPLEMENT_TOOLS constant includes 'Skill'
 *   2. buildCliArgs produces --allowedTools containing 'Skill' for implement-stage tools
 *   3. Stage-agent CLI tool arrays include 'Skill' at all three call sites
 *   4. ANTHROPIC_STAGE_TOOLS (read-only constant) does NOT include 'Skill' (it is the
 *      non-CLI agent baseline; Skill is appended only in the CLI tool arrays)
 *
 * @returns void
 */
import chalk from 'chalk';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { buildCliArgs } from '../../src/integrations/ai/adapters/claude-cli-runner';
import { createReporter, summarise } from './support/reporter';

const { counts, pass, fail } = createReporter();

const assert = (label: string, condition: boolean, detail?: string): void => {
  if (condition) {
    pass(label);
  } else {
    fail(label, detail);
  }
};

function checkImplementToolsIncludesSkill(adapterSource: string): void {
  const implementToolsMatch = /const IMPLEMENT_TOOLS\s*=\s*\[([^\]]+)\]/.exec(adapterSource);
  const implementToolsValue = implementToolsMatch?.[1] ?? '';
  assert(
    'IMPLEMENT_TOOLS constant includes Skill',
    implementToolsValue.includes('\'Skill\''),
    `Got: [${implementToolsValue}]`
  );
}

function checkBuildCliArgsAllowsSkill(): void {
  const implementTools = ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep', 'Skill'];
  const args = buildCliArgs({
    prompt: 'test prompt',
    model: 'claude-sonnet-4-6',
    cwd: '/tmp',
    tools: implementTools,
    permissionMode: 'acceptEdits',
  });
  const allowedToolsIdx = args.indexOf('--allowedTools');
  const allowedToolsValue = allowedToolsIdx >= 0 ? args[allowedToolsIdx + 1] : '';
  assert('buildCliArgs --allowedTools contains Skill for implement tools', allowedToolsValue.includes('Skill'), `Got: ${allowedToolsValue}`);
  assert('buildCliArgs --allowedTools preserves all 7 tools', allowedToolsValue.split(',').length === 7, `Expected 7 comma-separated tools, got: ${allowedToolsValue}`);
}

function checkStageAgentCliArraysHaveSkill(stageAgentSource: string): void {
  const cliToolArrayMatches = stageAgentSource.match(
    /tools:\s*allowInspection\s*\?\s*\['Read',\s*'Glob',\s*'Grep',\s*'Bash',\s*'Skill'\]/g
  );
  assert(
    'stage-agent.service.ts has exactly 3 CLI tool arrays with Skill',
    cliToolArrayMatches?.length === 3,
    `Expected 3 matches, got ${cliToolArrayMatches?.length ?? 0}`
  );
}

function checkAnthropicStageToolsLacksSkill(stageAgentSource: string): void {
  const stageToolsMatch = /const ANTHROPIC_STAGE_TOOLS\s*=\s*\[([^\]]+)\]/.exec(stageAgentSource);
  const stageToolsValue = stageToolsMatch?.[1] ?? '';
  assert(
    'ANTHROPIC_STAGE_TOOLS does not include Skill (agent baseline unchanged)',
    !stageToolsValue.includes('\'Skill\''),
    `Got: [${stageToolsValue}]`
  );
}

function main(): void {
  console.log(chalk.bold('\nSkill tool CLI allowlist smoke test\n'));
  const adapterSource = fs.readFileSync(path.join(process.cwd(), 'src/integrations/ai/adapters/claude-cli.adapter.ts'), 'utf-8');
  const stageAgentSource = fs.readFileSync(path.join(process.cwd(), 'src/integrations/ai/stage-agent.service.ts'), 'utf-8');
  checkImplementToolsIncludesSkill(adapterSource);
  checkBuildCliArgsAllowsSkill();
  checkStageAgentCliArraysHaveSkill(stageAgentSource);
  checkAnthropicStageToolsLacksSkill(stageAgentSource);
  summarise(counts);
}

main();
