/**
 * Manual smoke test: continuation prompt contains verification commands exactly once
 *
 * Run: nr test:manual continuation-verification-uniqueness.smoke.ts
 *
 * Verifies:
 *   1. All three adapters removed their legacy formatVerificationBlock functions.
 *   2. All three adapters call buildTaskBrief in buildContinuationPrompt.
 *   3. Live buildTaskBrief output contains 'Verification commands:' exactly once.
 *   4. Live buildTaskBrief output does NOT contain the legacy heading.
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
  if (condition) pass(label);
  else fail(label);
};

type AdapterSources = { anthropic: string; openai: string; cli: string };

function loadAdapterSources(): AdapterSources {
  const adaptersDir = path.join(__dirname, '..', '..', 'src', 'integrations', 'ai', 'adapters');
  return {
    anthropic: fs.readFileSync(path.join(adaptersDir, 'anthropic-agent.adapter.ts'), 'utf8'),
    openai: fs.readFileSync(path.join(adaptersDir, 'openai-agent.adapter.ts'), 'utf8'),
    cli: fs.readFileSync(path.join(adaptersDir, 'claude-cli.adapter.ts'), 'utf8'),
  };
}

function checkLegacyFunctionsRemoved(sources: AdapterSources): void {
  assert('Anthropic: formatVerificationBlock removed', !sources.anthropic.includes('formatVerificationBlock'));
  assert('OpenAI: formatOaiVerificationBlock removed', !sources.openai.includes('formatOaiVerificationBlock'));
  assert('CLI: formatCliVerificationBlock removed', !sources.cli.includes('formatCliVerificationBlock'));
}

function checkBuildTaskBriefUsed(sources: AdapterSources): void {
  assert('Anthropic buildContinuationPrompt calls buildTaskBrief', sources.anthropic.includes('buildTaskBrief(p.taskBriefParams)'));
  assert('OpenAI buildContinuationPrompt calls buildTaskBrief', sources.openai.includes('buildTaskBrief(p.taskBriefParams)'));
  assert('CLI buildContinuationPrompt calls buildTaskBrief', sources.cli.includes('buildTaskBrief(p.taskBriefParams)'));
}

function buildTestBrief(): string {
  return buildTaskBrief({
    ticketKey: 'VDUP-1',
    repoName: 'repo',
    repoFiles: ['repo/src/a.ts'],
    trackedFilePaths: ['repo/src/a.ts'],
    verificationScripts: [
      { id: 'lint', name: 'lint', command: 'yarn lint', policy: 'enforced', aliases: [] },
      { id: 'test', name: 'test', command: 'yarn test', policy: 'enforced', aliases: [] },
    ],
    planSteps: ['Fix lint'],
    planSummary: 'Fix lint errors',
    planAction: 'fix',
  });
}

function checkVerificationUniqueness(brief: string): void {
  const verificationCount = (brief.match(/Verification commands:/g) ?? []).length;
  assert(`buildTaskBrief contains 'Verification commands:' exactly once (got ${verificationCount})`, verificationCount === 1);
  assert("buildTaskBrief does NOT contain 'Verification (run after all edits):'", !brief.includes('Verification (run after all edits):'));
  assert('buildTaskBrief contains yarn lint', brief.includes('yarn lint'));
  assert('buildTaskBrief contains yarn test', brief.includes('yarn test'));
}

async function main(): Promise<void> {
  console.log(chalk.bold('\n  continuation-verification-uniqueness smoke test\n'));
  const sources = loadAdapterSources();
  checkLegacyFunctionsRemoved(sources);
  checkBuildTaskBriefUsed(sources);
  const brief = buildTestBrief();
  checkVerificationUniqueness(brief);
  summarise(counts);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
