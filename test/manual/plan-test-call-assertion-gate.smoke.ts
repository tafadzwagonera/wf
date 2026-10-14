/**
 * Manual smoke test: issue:plan flags a spec step that uses a mocked collaborator without a call assertion; the rule
 * is advisory, retried once, and waivable
 *
 * Run (after `yarn build`): nr test:manual plan-test-call-assertion-gate.smoke
 *
 * Scenario: `node dist/main.js issue:plan --action fix --custom-plan source.md --silent` with a fake `claude` that
 * returns a plan whose single step adds a spec using a mocked `fs.readFileSync`. The plan stage validates the draft,
 * retries once with the violation in the repair prompt, and prints the violations that persist.
 *
 * Config under test:
 *   stages: { plan: { provider: 'anthropic', backend: 'cli' } }
 *
 * Verify:
 *   1. Step with a mock and no call assertion: output reports `[test-call-assertion-required]`, the repair prompt
 *      carries the rule, the command exits 0 and writes a plan artifact, and the planner is spawned twice.
 *   2. Step that asserts `toHaveBeenCalledTimes` / `mock.calls`: no violation, one spawn.
 *   3. Step that asserts the collaborator is never called: no violation.
 *   4. Same flagged step with a `test-call-assertion-required` waiver: no violation.
 *   5. Mock step that names no spec file: no violation.
 *
 * Wire up: support/plan-cli-harness.ts (temp repo, fake `claude` on PATH, isolated HOME); requires `yarn build`.
 * Teardown: each variant's temp root (repo, bin, home, prompts) is removed.
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

const RULE_ID = 'test-call-assertion-required';
const RULE_TAG = `[${RULE_ID}]`;
const flaggedStep = 'Add repo/src/reader.spec.ts that uses a mocked `fs.readFileSync` and checks the returned text.';

const buildPlan = (step: string, verification?: Record<string, unknown>): Record<string, unknown> => ({
  action: 'fix',
  summary: 'Cover the reader',
  steps: [step],
  estimatedComplexity: 'low',
  affectedFiles: [{ filePath: 'repo/src/reader.ts', status: 'found' }],
  affectedRepositories: ['repo'],
  risks: [],
  ...(verification ? { verification } : {}),
});

const files = { 'src/reader.ts': 'export {};\n' };

const withHarness = <T>(plan: Record<string, unknown>, fn: (harness: PlanHarness, result: PlanRunResult) => T): T => {
  const harness = setupPlanHarness('wf-call-assert-gate-', plan, files);
  try {
    return fn(harness, runPlan(harness));
  } finally {
    cleanupPlanHarness(harness);
  }
};

const artifactWritten = (harness: PlanHarness): boolean => {
  const dir = path.join(harness.homeDir, '.wf', 'repo');
  return fs.existsSync(dir) && fs.readdirSync(dir).length > 0;
};

function verifyFlaggedStep(): void {
  withHarness(buildPlan(flaggedStep), (harness, { exitCode, output }) => {
    assert('mock step without call assertion is flagged', output.includes(RULE_TAG), output.slice(-800));
    assert('violation persists after the repair retry', output.includes('Plan quality violations persisted after retry'));
    assert('repair prompt carries the rule', readPlanPrompt(harness, 2).includes(RULE_ID));
    assert('rule is advisory: exit 0', exitCode === 0, output.slice(-400));
    assert('rule is advisory: plan artifact written', artifactWritten(harness));
    assert('planner was spawned twice', countPlanSpawns(harness) === 2, `spawns=${countPlanSpawns(harness)}`);
  });
}

function verifyUnflagged(label: string, plan: Record<string, unknown>, expectedSpawns?: number): void {
  withHarness(plan, (harness, { output }) => {
    assert(`${label}: no violation`, !output.includes(RULE_TAG), output.slice(-800));
    if (expectedSpawns !== undefined) {
      assert(`${label}: no repair retry`, countPlanSpawns(harness) === expectedSpawns, `spawns=${countPlanSpawns(harness)}`);
    }
  });
}

const verifyCallGate = (): void => {
  verifyFlaggedStep();
  const calledStep = `${flaggedStep.replace(/\.$/, '')}; assert \`toHaveBeenCalledTimes(1)\` and inspect \`mock.calls\`.`;
  verifyUnflagged('call-count assertion', buildPlan(calledStep), 1);
  const neverStep = `${flaggedStep.replace(/\.$/, '')}; assert the mocked notifier is never called on empty input.`;
  verifyUnflagged('never-called assertion', buildPlan(neverStep));
  const waivers = { waivers: [{ id: RULE_ID, reason: 'output-only check' }] };
  verifyUnflagged('waiver', buildPlan(flaggedStep, waivers));
  verifyUnflagged('no spec file named', buildPlan('Introduce a mock adapter in repo/src/adapter.ts.'));
  summarise(counts);
};

const failMissingDist = (): never => {
  fail('dist/main.js must exist', 'Run `yarn build` first.');
  return process.exit(1);
};

function main(): void {
  console.log(chalk.bold.cyan('\n  Test call-assertion plan gate — live smoke test\n'));
  const run = fs.existsSync(distMainPath) ? verifyCallGate : failMissingDist;
  run();
}

main();
