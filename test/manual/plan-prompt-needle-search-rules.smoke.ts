/**
 * Manual smoke test: the issue:plan prompt carries the case-insensitive whole-repository search rule, the
 * .gitignore note and the to-delete file status
 *
 * Run (after `yarn build`): nr test:manual plan-prompt-needle-search-rules.smoke
 *
 * Scenario: `node dist/main.js issue:plan --action fix --custom-plan source.md --silent` with the plan stage on the
 * claude CLI backend. A fake `claude` records its argv and stdin prompt, then returns a minimal valid plan.
 *
 * Config under test:
 *   stages: { plan: { provider: 'anthropic', backend: 'cli' } }
 *
 * Verify:
 *   1. The command exits 0 and writes a plan artifact under the isolated HOME.
 *   2. The prompt contains the broad case-insensitive substring search rule and "across the whole repository".
 *   3. The prompt contains "git grep --no-index" and "honours .gitignore".
 *   4. The prompt lists "to-delete" for orphaned files the plan deletes.
 *   5. The prompt still carries the original "Plan step principles" block.
 *
 * Wire up: support/plan-cli-harness.ts (temp repo, fake `claude` on PATH, isolated HOME); requires `yarn build`.
 * Teardown: the temp root (repo, bin, home, prompts) is removed.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import chalk from 'chalk';
import {
  cleanupPlanHarness, distMainPath, readPlanPrompt, runPlan, setupPlanHarness, type PlanHarness,
} from './support/plan-cli-harness';
import { createReporter, summarise } from './support/reporter';

const { counts, pass, fail } = createReporter();

const assert = (label: string, condition: boolean, detail?: string): void =>
  condition ? pass(label) : fail(label, detail);

const plan = {
  action: 'fix',
  summary: 'Smoke plan',
  steps: ['Add a note to repo/src/a.ts.'],
  estimatedComplexity: 'low',
  affectedFiles: [{ filePath: 'repo/src/a.ts', status: 'found' }],
  affectedRepositories: ['repo'],
  risks: [],
};

const artifactCount = (harness: PlanHarness): number => {
  const dir = path.join(harness.homeDir, '.wf', 'repo');
  return fs.existsSync(dir) ? fs.readdirSync(dir).length : 0;
};

function verifyPrompt(prompt: string): void {
  assert('search rule is in the prompt', prompt.includes('broad case-insensitive substring search'), prompt.slice(0, 400));
  assert('rule covers the whole repository', prompt.includes('across the whole repository'));
  assert('.gitignore note names git grep --no-index', prompt.includes('git grep --no-index'));
  assert('.gitignore note mentions Grep honouring .gitignore', prompt.includes('honours .gitignore'));
  assert('to-delete status is listed', prompt.includes('"to-delete" for orphaned files the plan deletes'));
  assert('step principles block is intact', prompt.includes('Plan step principles'));
}

function verifyPlanPrompt(): void {
  const harness = setupPlanHarness('wf-plan-needle-prompt-', plan, { 'src/a.ts': 'export {};\n' });
  try {
    const { exitCode, output } = runPlan(harness);
    assert('command exits 0', exitCode === 0, output.slice(-600));
    assert('plan artifact was written', artifactCount(harness) > 0);
    verifyPrompt(readPlanPrompt(harness, 1));
  } finally {
    cleanupPlanHarness(harness);
  }
  summarise(counts);
}

const failMissingDist = (): never => {
  fail('dist/main.js must exist', 'Run `yarn build` first.');
  return process.exit(1);
};

function main(): void {
  console.log(chalk.bold.cyan('\n  Plan prompt needle-search rules — live smoke test\n'));
  const run = fs.existsSync(distMainPath) ? verifyPlanPrompt : failMissingDist;
  run();
}

main();
