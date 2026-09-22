/**
 * Manual smoke test: CLI continuation prompt self-sufficient fields
 *
 * Run: nr test:manual cli-continuation-prompt-self-sufficient.smoke.ts
 *
 * Verifies:
 *   1. The CLI adapter's buildContinuationPrompt uses taskBriefParams and calls buildTaskBrief.
 *   2. Structural parity with Anthropic and OpenAI adapters (all embed buildTaskBrief).
 *   3. formatCliVerificationBlock is removed (verification now delegated to buildTaskBrief).
 *   4. taskBriefParams in ContinuationLoopParams carries phases from the plan.
 *   5. Live buildTaskBrief call includes phase checkpoints.
 *   6. taskBriefParams is threaded from session params through to continuation prompts.
 *
 * @returns Promise that resolves when the smoke test completes
 */
import chalk from 'chalk';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { buildTaskBrief } from '../../src/integrations/ai/adapters/shared-routing';
import { createReporter, summarise } from './support/reporter';

const { counts, pass, fail } = createReporter();

const assert = (label: string, condition: boolean): void => {
  if (condition) {
    pass(label);
  } else {
    fail(label);
  }
};

const adaptersDir = path.join(__dirname, '..', '..', 'src', 'integrations', 'ai', 'adapters');

type AdapterSources = { cliSource: string; anthropicSource: string; openaiSource: string };

function readAdapterSources(): AdapterSources {
  return {
    cliSource: fs.readFileSync(path.join(adaptersDir, 'claude-cli.adapter.ts'), 'utf8'),
    anthropicSource: fs.readFileSync(path.join(adaptersDir, 'anthropic-agent.adapter.ts'), 'utf8'),
    openaiSource: fs.readFileSync(path.join(adaptersDir, 'openai-agent.adapter.ts'), 'utf8'),
  };
}

function checkCliUsesTaskBriefParams(src: AdapterSources): void {
  console.log(chalk.bold('\n  Scenario 1: CLI buildContinuationPrompt uses taskBriefParams\n'));
  assert('CLI defines CliContinuationPromptParams type', src.cliSource.includes('type CliContinuationPromptParams'));
  assert('CliContinuationPromptParams includes totalPlanned', src.cliSource.includes('totalPlanned: number'));
  assert('CliContinuationPromptParams includes passNumber', src.cliSource.includes('passNumber: number'));
  assert('CliContinuationPromptParams includes taskBriefParams', src.cliSource.includes('taskBriefParams: BuildPlanContextParams'));
  assert('CliContinuationPromptParams does not have planSummary', !src.cliSource.includes('type CliContinuationPromptParams') || !/type CliContinuationPromptParams[\s\S]{0,200}planSummary: string/.exec(src.cliSource));
  assert('CLI prompt emits Progress header', src.cliSource.includes('`Progress: ${completed}/${p.totalPlanned} files modified (pass ${p.passNumber})`'));
  assert('CLI buildContinuationPrompt calls buildTaskBrief', src.cliSource.includes('buildTaskBrief(p.taskBriefParams)'));
  assert('CLI prompt does not emit legacy Goal line', !src.cliSource.includes('`Goal: ${p.planSummary}`'));
}

function checkAdapterParity(src: AdapterSources): void {
  console.log(chalk.bold('\n  Scenario 2: structural parity with other adapters\n'));
  assert('Anthropic prompt emits Progress header', src.anthropicSource.includes('files modified (pass ${p.passNumber})'));
  assert('OpenAI prompt emits Progress header', src.openaiSource.includes('files modified (pass ${p.passNumber})'));
  assert('Anthropic buildContinuationPrompt calls buildTaskBrief', src.anthropicSource.includes('buildTaskBrief('));
  assert('OpenAI buildContinuationPrompt calls buildTaskBrief', src.openaiSource.includes('buildTaskBrief('));
  assert('All three adapters use the same Progress template',
    src.cliSource.includes('files modified (pass ${p.passNumber})')
    && src.anthropicSource.includes('files modified (pass ${p.passNumber})')
    && src.openaiSource.includes('files modified (pass ${p.passNumber})')
  );
}

function checkFormatCliVerificationBlockRemoved(src: AdapterSources): void {
  console.log(chalk.bold('\n  Scenario 3: formatCliVerificationBlock removed (verification via buildTaskBrief)\n'));
  assert('formatCliVerificationBlock is no longer defined in CLI adapter', !src.cliSource.includes('formatCliVerificationBlock'));
  assert('buildTaskBrief is imported from shared-routing in CLI adapter', src.cliSource.includes('buildTaskBrief') && src.cliSource.includes("from './shared-routing'"));
}

function checkPhasesInTaskBrief(src: AdapterSources): void {
  console.log(chalk.bold('\n  Scenario 4: task brief includes phases\n'));
  assert('ContinuationLoopParams uses taskBriefParams (carries phases via BuildPlanContextParams)', src.cliSource.includes('type ContinuationLoopParams') && src.cliSource.includes('taskBriefParams: BuildPlanContextParams'));
  assert('createCliSessionParams builds taskBriefParams with phases from plan', src.cliSource.includes('phases: params.planArtifact.plan.phases'));
}

function buildLiveTaskBriefParams() {
  return {
    ticketKey: 'SMOKE-2', repoName: 'repo', repoFiles: ['repo/src/a.ts'],
    trackedFilePaths: ['repo/src/a.ts'],
    verificationScripts: [{ id: 'build', name: 'build', command: 'yarn build', policy: 'enforced' as const, aliases: [] as string[] }],
    planSteps: ['Step A', 'Step B'], planSummary: 'Test phases', planAction: 'feature' as const,
    phases: [
      { label: 'Phase Alpha', stepIndices: [0], verifyAfter: ['yarn lint'] },
      { label: 'Phase Beta', stepIndices: [1] },
    ],
  };
}

function checkLiveBuildTaskBrief(): void {
  console.log(chalk.bold('\n  Scenario 5: live buildTaskBrief includes phase checkpoints\n'));
  const taskBrief = buildTaskBrief(buildLiveTaskBriefParams());
  assert('taskBrief contains Phase checkpoints header', taskBrief.includes('## Phase checkpoints'));
  assert('taskBrief contains Phase Alpha', taskBrief.includes('Phase 1: Phase Alpha'));
  assert('taskBrief contains Phase Beta', taskBrief.includes('Phase 2: Phase Beta'));
  assert('taskBrief contains phase verify command', taskBrief.includes('Verify: yarn lint'));
}

function checkDataThreading(src: AdapterSources): void {
  console.log(chalk.bold('\n  Scenario 6: data threading from session params to prompt\n'));
  assert('CliSessionParams includes taskBriefParams field', src.cliSource.includes('taskBriefParams: BuildPlanContextParams') && src.cliSource.includes('type CliSessionParams'));
  assert('ContinuationLoopParams includes taskBriefParams', src.cliSource.includes('type ContinuationLoopParams') && src.cliSource.includes('taskBriefParams: BuildPlanContextParams'));
  assert('createCliSessionParams builds taskBriefParams from planArtifact', src.cliSource.includes('planSummary: params.planArtifact.plan.summary') && src.cliSource.includes('planSteps: params.planArtifact.plan.steps'));
  assert('executePassAndDiscover passes taskBriefParams to runSinglePass', src.cliSource.includes('taskBriefParams: p.taskBriefParams'));
}

async function main(): Promise<void> {
  console.log(chalk.bold('\nSmoke test: CLI continuation prompt self-sufficient fields\n'));
  const src = readAdapterSources();
  checkCliUsesTaskBriefParams(src);
  checkAdapterParity(src);
  checkFormatCliVerificationBlockRemoved(src);
  checkPhasesInTaskBrief(src);
  checkLiveBuildTaskBrief();
  checkDataThreading(src);
  summarise(counts);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
