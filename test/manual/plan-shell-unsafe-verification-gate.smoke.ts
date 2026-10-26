/**
 * Manual smoke test: issue:plan flags a double-quoted bash -c verification command with
 * unescaped $ expansion, prints the retry notice, and feeds the rule into the repair prompt.
 *
 * Run (after `yarn build`): nr test:manual plan-shell-unsafe-verification-gate.smoke
 *
 * Overlap note: plan-test-call-assertion-gate.smoke.ts covers the same gate loop for
 * test-call-assertion-required; this test covers only the shell-unsafe-verification-command
 * rule plus the "retrying with feedback" notice.
 *
 * Verifies:
 *   1. output reports [shell-unsafe-verification-command] naming the targeted command id
 *   2. output contains the "Plan quality violations (retrying with feedback)" notice
 *   3. the repair prompt (spawn 2) carries the rule id
 *   4. the planner was spawned exactly twice
 *   5. the command exits 0 and the saved artifact records the violation as a [plan-quality] risk
 *   6. the single-quoted form of the same command produces no violation and a single spawn
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import chalk from 'chalk';
import {
  cleanupPlanHarness, countPlanSpawns, distMainPath, readPlanPrompt, runPlan, setupPlanHarness,
  type PlanHarness, type PlanRunResult,
} from './support/plan-cli-harness';
import { createReporter, summarise } from './support/reporter';

const { counts, pass, fail } = createReporter();

const assert = (label: string, condition: boolean, detail?: string): void =>
  condition ? pass(label) : fail(label, detail);

const RULE_ID = 'shell-unsafe-verification-command';
const unsafeRun
  = 'bash -c "f=$(mktemp) && echo \'chore(release): Set version to 0.1.0\' > $f && sh .lefthook/check.sh $f"';
const safeRun
  = "bash -c 'f=$(mktemp) && echo ok > $f && sh .lefthook/check.sh $f'";

const buildPlan = (run: string): Record<string, unknown> => ({
  action: 'fix',
  summary: 'Automate the release hook check',
  steps: [{ description: 'Add the release command to repo/package.json.' }],
  estimatedComplexity: 'low',
  affectedFiles: [{ filePath: 'repo/package.json', status: 'found' }],
  affectedRepositories: ['repo'],
  risks: [],
  verification: { targeted: [{ id: 'hook-check', run, policy: 'enforced', reason: 'hook regex' }] },
});

const repoFiles = { 'package.json': '{ "name": "repo" }\n' };

const withHarness = <T>(plan: Record<string, unknown>, fn: (harness: PlanHarness, result: PlanRunResult) => T): T => {
  const harness = setupPlanHarness('wf-shell-unsafe-gate-', plan, repoFiles);
  try {
    return fn(harness, runPlan(harness));
  } finally {
    cleanupPlanHarness(harness);
  }
};

const readArtifactRisks = (harness: PlanHarness): string => {
  const dir = path.join(harness.homeDir, '.wf', 'repo');
  const name = fs.existsSync(dir) ? fs.readdirSync(dir).find(file => file.endsWith('-fix-plan.json')) : undefined;
  if (!name) return '';
  const plan = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf-8'));
  return JSON.stringify(plan.risks ?? []);
};

const assertUnsafeFlagged = (output: string): void => {
  assert('unsafe command is flagged with the rule id', output.includes(`[${RULE_ID}]`), output.slice(-800));
  assert('violation names the targeted command id', output.includes('hook-check'));
  assert(
    'retry notice is printed before regenerating',
    output.includes('Plan quality violations (retrying with feedback)'),
    output.slice(-800),
  );
};

const assertRetryOutcome = (harness: PlanHarness, exitCode: number | null, output: string): void => {
  assert('repair prompt carries the rule', readPlanPrompt(harness, 2).includes(RULE_ID));
  assert('planner was spawned twice', countPlanSpawns(harness) === 2, `spawns=${countPlanSpawns(harness)}`);
  assert('rule is non-fatal: exit 0', exitCode === 0, output.slice(-400));
  const risks = readArtifactRisks(harness);
  assert('persisted violation lands in the artifact risks', risks.includes(RULE_ID), risks.slice(0, 300));
};

const verifyUnsafeCommand = (): void => {
  withHarness(buildPlan(unsafeRun), (harness, { exitCode, output }) => {
    assertUnsafeFlagged(output);
    assertRetryOutcome(harness, exitCode, output);
  });
};

const verifySafeCommand = (): void => {
  withHarness(buildPlan(safeRun), (harness, { output }) => {
    assert('single-quoted command produces no violation', !output.includes(`[${RULE_ID}]`), output.slice(-800));
    assert('single-quoted command needs no retry', countPlanSpawns(harness) === 1, `spawns=${countPlanSpawns(harness)}`);
  });
};

const failMissingDist = (): never => {
  fail('dist/main.js must exist', 'Run `yarn build` first.');
  return process.exit(1);
};

const main = (): void => {
  console.log(chalk.bold.cyan('\n  shell-unsafe verification command plan gate smoke test\n'));
  if (!fs.existsSync(distMainPath)) failMissingDist();
  verifyUnsafeCommand();
  verifySafeCommand();
  summarise(counts);
};

main();
