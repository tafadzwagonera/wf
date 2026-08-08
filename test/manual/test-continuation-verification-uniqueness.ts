/**
 * Manual smoke test: continuation prompt contains verification commands exactly once
 *
 * Run: nr test:manual -- test-continuation-verification-uniqueness
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
import * as fs from 'fs';
import * as path from 'path';
import { buildTaskBrief } from '../../src/integrations/ai/adapters/shared-routing';

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

const run = async (): Promise<void> => {
  const adaptersDir = path.join(__dirname, '..', '..', 'src', 'integrations', 'ai', 'adapters');
  const anthropicSource = fs.readFileSync(path.join(adaptersDir, 'anthropic-agent.adapter.ts'), 'utf8');
  const openaiSource = fs.readFileSync(path.join(adaptersDir, 'openai-agent.adapter.ts'), 'utf8');
  const cliSource = fs.readFileSync(path.join(adaptersDir, 'claude-cli.adapter.ts'), 'utf8');

  console.log(chalk.bold('\n  Scenario 1: legacy formatVerificationBlock removed from all adapters\n'));

  assert('Anthropic: formatVerificationBlock removed', !anthropicSource.includes('formatVerificationBlock'));
  assert('OpenAI: formatOaiVerificationBlock removed', !openaiSource.includes('formatOaiVerificationBlock'));
  assert('CLI: formatCliVerificationBlock removed', !cliSource.includes('formatCliVerificationBlock'));

  console.log(chalk.bold('\n  Scenario 2: all adapters call buildTaskBrief in continuation prompt\n'));

  assert('Anthropic buildContinuationPrompt calls buildTaskBrief',
    anthropicSource.includes('buildTaskBrief(p.taskBriefParams)'));
  assert('OpenAI buildContinuationPrompt calls buildTaskBrief',
    openaiSource.includes('buildTaskBrief(p.taskBriefParams)'));
  assert('CLI buildContinuationPrompt calls buildTaskBrief',
    cliSource.includes('buildTaskBrief(p.taskBriefParams)'));

  console.log(chalk.bold('\n  Scenario 3: live verification uniqueness\n'));

  const brief = buildTaskBrief({
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

  const verificationCount = (brief.match(/Verification commands:/g) ?? []).length;
  assert(`buildTaskBrief contains 'Verification commands:' exactly once (got ${verificationCount})`,
    verificationCount === 1);
  assert("buildTaskBrief does NOT contain 'Verification (run after all edits):'",
    !brief.includes('Verification (run after all edits):'));
  assert('buildTaskBrief contains yarn lint', brief.includes('yarn lint'));
  assert('buildTaskBrief contains yarn test', brief.includes('yarn test'));

  console.log(chalk.bold(`\nResults: ${passed} passed, ${failed} failed\n`));
  if (failed > 0) process.exit(1);
};

void run();
