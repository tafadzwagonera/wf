/**
 * Manual smoke test: the Claude CLI review turn and the Claude CLI plan turn are both granted
 * sub-agent tools (Task, Agent); the review epilogue stays inspection-only
 *
 * Run (after `yarn build`): nr test:manual review-subagent-tool-grant.smoke
 *
 * Scenario: `node dist/main.js issue:review --silent --skip-verification` with the review stage on the
 * claude CLI backend and an uncommitted change in a temp git repo. A fake `claude` records each spawn's
 * argv and stdin, then returns a minimal approved review. A second scenario runs `issue:plan` through
 * the plan harness on the same backend.
 *
 * Config under test:
 *   stages: { review: { provider: 'anthropic', backend: 'cli' }, plan: { provider: 'anthropic', backend: 'cli' } }
 *
 * Verify:
 *   1. The review command exits 0 and spawns the fake claude exactly twice (main turn, epilogue).
 *   2. Spawn 1 (main review turn) receives --allowedTools Read,Glob,Grep,Bash,Skill,Task,Agent.
 *   3. Spawn 2 (review epilogue) receives --allowedTools Read,Glob,Grep,Bash,Skill.
 *   4. A plan-stage run through the plan harness receives --allowedTools Read,Glob,Grep,Bash,Skill,Task,Agent.
 *
 * Wire up: support/review-cli-harness.ts and support/plan-cli-harness.ts (temp repos, fake `claude`
 * on PATH, isolated HOME); requires `yarn build`.
 * Teardown: both harness temp roots (repo, bin, home, prompts) are removed.
 */
import * as fs from 'node:fs';
import chalk from 'chalk';
import {
  cleanupReviewHarness, countReviewSpawns, distMainPath, readAllowedTools, readReviewPrompt,
  runReview, setupReviewHarness, type ReviewHarness,
} from './support/review-cli-harness';
import { cleanupPlanHarness, readPlanPrompt, runPlan, setupPlanHarness } from './support/plan-cli-harness';
import { createReporter, summarise } from './support/reporter';

const { counts, pass, fail } = createReporter();

const assert = (label: string, condition: boolean, detail?: string): void =>
  condition ? pass(label) : fail(label, detail);

const review = {
  summary: 'Smoke review',
  issues: [],
  suggestions: [],
  approved: true,
};

const plan = {
  action: 'fix',
  summary: 'Smoke plan',
  steps: ['Add a note to repo/src/a.ts.'],
  estimatedComplexity: 'low',
  affectedFiles: [{ filePath: 'repo/src/a.ts', status: 'found' }],
  affectedRepositories: ['repo'],
  risks: [],
};

function verifyReviewTurnTools(harness: ReviewHarness): void {
  const mainTools = readAllowedTools(readReviewPrompt(harness, 1));
  assert('main review turn is granted sub-agent tools',
    mainTools === 'Read,Glob,Grep,Bash,Skill,Task,Agent', `--allowedTools=${mainTools}`);
  const epilogueTools = readAllowedTools(readReviewPrompt(harness, 2));
  assert('review epilogue stays inspection-only',
    epilogueTools === 'Read,Glob,Grep,Bash,Skill', `--allowedTools=${epilogueTools}`);
}

function verifyReviewToolGrants(): void {
  const harness = setupReviewHarness('wf-review-subagent-tools-', review);
  try {
    const { exitCode, output } = runReview(harness);
    assert('review command exits 0', exitCode === 0, output.slice(-600));
    assert('fake claude spawned exactly twice', countReviewSpawns(harness) === 2,
      `spawns=${countReviewSpawns(harness)}`);
    verifyReviewTurnTools(harness);
  } finally {
    cleanupReviewHarness(harness);
  }
}

function verifyPlanToolGrants(): void {
  const harness = setupPlanHarness('wf-plan-subagent-tools-', plan, { 'src/a.ts': 'export {};\n' });
  try {
    const { exitCode, output } = runPlan(harness);
    assert('plan command exits 0', exitCode === 0, output.slice(-600));
    const planTools = readAllowedTools(readPlanPrompt(harness, 1));
    assert('plan turn is granted sub-agent tools',
      planTools === 'Read,Glob,Grep,Bash,Skill,Task,Agent', `--allowedTools=${planTools}`);
  } finally {
    cleanupPlanHarness(harness);
  }
}

const failMissingDist = (): never => {
  fail('dist/main.js must exist', 'Run `yarn build` first.');
  return process.exit(1);
};

function main(): void {
  console.log(chalk.bold.cyan('\n  Review sub-agent tool grant — smoke test\n'));
  if (!fs.existsSync(distMainPath)) failMissingDist();
  verifyReviewToolGrants();
  verifyPlanToolGrants();
  summarise(counts);
}

main();
