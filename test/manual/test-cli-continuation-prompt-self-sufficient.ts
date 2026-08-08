/**
 * Manual smoke test: CLI continuation prompt self-sufficient fields
 *
 * Run: nr test:manual -- test-cli-continuation-prompt-self-sufficient
 *
 * Verifies:
 *   1. The CLI adapter's buildContinuationPrompt includes all six self-sufficient
 *      fields (progress, goal, plan steps, conventions, unvisited, verification).
 *   2. Structural parity with Anthropic and OpenAI adapters (Progress template).
 *   3. formatCliVerificationBlock returns empty string for empty command lists.
 *   4. buildCliSystemPromptParams passes phases to buildSystemPrompt.
 *   5. buildSystemPrompt renders phase checkpoints (live call).
 *   6. planSummary and planSteps are threaded from session params to prompt.
 *
 * @returns Promise that resolves when the smoke test completes
 */
import chalk from 'chalk';
import * as fs from 'fs';
import * as path from 'path';
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

const adaptersDir = path.join(__dirname, '..', '..', 'src', 'integrations', 'ai', 'adapters');

const run = async (): Promise<void> => {
  console.log(chalk.bold('\nSmoke test: CLI continuation prompt self-sufficient fields\n'));

  const cliSource = fs.readFileSync(path.join(adaptersDir, 'claude-cli.adapter.ts'), 'utf8');
  const anthropicSource = fs.readFileSync(path.join(adaptersDir, 'anthropic-agent.adapter.ts'), 'utf8');
  const openaiSource = fs.readFileSync(path.join(adaptersDir, 'openai-agent.adapter.ts'), 'utf8');

  console.log(chalk.bold('\n  Scenario 1: CLI buildContinuationPrompt includes all six fields\n'));

  assert(
    'CLI defines CliContinuationPromptParams type',
    cliSource.includes('type CliContinuationPromptParams')
  );
  assert(
    'CliContinuationPromptParams includes totalPlanned',
    cliSource.includes('totalPlanned: number')
  );
  assert(
    'CliContinuationPromptParams includes passNumber',
    cliSource.includes('passNumber: number')
  );
  assert(
    'CliContinuationPromptParams includes planSummary',
    cliSource.includes('planSummary: string')
  );
  assert(
    'CliContinuationPromptParams includes planSteps',
    cliSource.includes('planSteps: string[]')
  );
  assert(
    'CliContinuationPromptParams includes verificationCommands',
    cliSource.includes('verificationCommands: string[]')
  );
  assert(
    'CliContinuationPromptParams includes conventionsSection',
    cliSource.includes('conventionsSection?: string')
  );

  assert(
    'CLI prompt emits Progress header',
    cliSource.includes('`Progress: ${completed}/${p.totalPlanned} files modified (pass ${p.passNumber})`')
  );
  assert(
    'CLI prompt emits Goal line',
    cliSource.includes('`Goal: ${p.planSummary}`')
  );
  assert(
    'CLI prompt emits Plan steps block',
    cliSource.includes('Plan steps:')
  );
  assert(
    'CLI prompt calls formatCliVerificationBlock',
    cliSource.includes('formatCliVerificationBlock(p.verificationCommands)')
  );
  assert(
    'CLI prompt includes conventions conditional',
    cliSource.includes("p.conventionsSection ? `\\n${p.conventionsSection}` : ''")
  );

  console.log(chalk.bold('\n  Scenario 2: structural parity with other adapters\n'));

  assert(
    'Anthropic prompt emits Progress header',
    anthropicSource.includes('`Progress: ${completed}/${p.totalPlanned} files modified (pass ${p.passNumber})`')
  );
  assert(
    'OpenAI prompt emits Progress header',
    openaiSource.includes('`Progress: ${completed}/${p.totalPlanned} files modified (pass ${p.passNumber})`')
  );
  assert(
    'Anthropic prompt emits Goal line',
    anthropicSource.includes('`Goal: ${p.planSummary}`')
  );
  assert(
    'OpenAI prompt emits Goal line',
    openaiSource.includes('`Goal: ${p.planSummary}`')
  );
  assert(
    'All three adapters use the same Progress template',
    cliSource.includes('files modified (pass ${p.passNumber})')
    && anthropicSource.includes('files modified (pass ${p.passNumber})')
    && openaiSource.includes('files modified (pass ${p.passNumber})')
  );

  console.log(chalk.bold('\n  Scenario 3: formatCliVerificationBlock handles empty input\n'));

  assert(
    'formatCliVerificationBlock returns empty for zero commands',
    cliSource.includes('commands.length > 0')
    && cliSource.includes(": ''")
  );

  console.log(chalk.bold('\n  Scenario 4: CLI system prompt includes phases\n'));

  assert(
    'extractPlanFields spreads phases into system prompt params',
    cliSource.includes('phases: plan.phases')
  );
  assert(
    'buildCliSystemPromptParams calls extractPlanFields',
    cliSource.includes('...extractPlanFields(params.planArtifact.plan)')
  );

  console.log(chalk.bold('\n  Scenario 5: live buildSystemPrompt includes phase checkpoints\n'));

  const systemPrompt = buildSystemPrompt({
    ticketKey: 'SMOKE-2',
    repoDir: '/tmp/repo',
    repoName: 'repo',
    repoFiles: ['repo/src/a.ts'],
    trackedFilePaths: ['repo/src/a.ts'],
    verificationScripts: [{ id: 'build', name: 'build', command: 'yarn build', policy: 'enforced', aliases: [] }],
    planSteps: ['Step A', 'Step B'],
    planSummary: 'Test phases',
    planAction: 'feature',
    phases: [
      { label: 'Phase Alpha', stepIndices: [0], verifyAfter: ['yarn lint'] },
      { label: 'Phase Beta', stepIndices: [1] },
    ],
  });

  assert('systemPrompt contains Phase checkpoints header', systemPrompt.includes('## Phase checkpoints'));
  assert('systemPrompt contains Phase Alpha', systemPrompt.includes('Phase 1: Phase Alpha'));
  assert('systemPrompt contains Phase Beta', systemPrompt.includes('Phase 2: Phase Beta'));
  assert('systemPrompt contains phase verify command', systemPrompt.includes('Verify: yarn lint'));

  console.log(chalk.bold('\n  Scenario 6: data threading from session params to prompt\n'));

  assert(
    'CliSessionParams includes planSummary field',
    cliSource.includes('planSummary: string') && cliSource.includes('type CliSessionParams')
  );
  assert(
    'CliSessionParams includes planSteps field',
    cliSource.includes('planSteps: string[]') && cliSource.includes('type CliSessionParams')
  );
  assert(
    'ContinuationLoopParams includes planSummary',
    cliSource.includes('type ContinuationLoopParams') && cliSource.includes('planSummary: string')
  );
  assert(
    'createCliSessionParams reads summary from planArtifact',
    cliSource.includes('planSummary: params.planArtifact.plan.summary')
  );
  assert(
    'createCliSessionParams reads steps from planArtifact',
    cliSource.includes('planSteps: params.planArtifact.plan.steps')
  );
  assert(
    'executePassAndDiscover passes planSummary to runSinglePass',
    cliSource.includes('planSummary: p.planSummary')
  );
  assert(
    'executePassAndDiscover passes planSteps to runSinglePass',
    cliSource.includes('planSteps: p.planSteps')
  );
  assert(
    'executePassAndDiscover derives verificationCommands from scripts',
    cliSource.includes('verificationCommands: p.verificationScripts.map(vs => vs.command)')
  );

  console.log(chalk.bold(`\nResults: ${passed} passed, ${failed} failed\n`));

  if (failed > 0) process.exit(1);
};

run();
