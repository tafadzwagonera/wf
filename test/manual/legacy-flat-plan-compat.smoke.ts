/**
 * Manual smoke test: a pre-feature plan artifact with flat string steps still implements
 * correctly through the compiled CLI — each string loads as an intent-less step object.
 *
 * Run (after `yarn build`): nr test:manual legacy-flat-plan-compat.smoke
 *
 * Overlap note: plan-step-intent-fidelity.smoke.ts covers the canonical combined step shape
 * ({ description, intent }); this test covers the flat pre-feature format, the only legacy
 * shape still supported.
 *
 * Verifies:
 *   1. compiled issue:implement exits 0 on a flat-steps plan artifact
 *   2. the step text reaches the implementer prompt unchanged
 */
import * as fs from 'node:fs';
import chalk from 'chalk';
import {
  cleanupHarness, distMainPath, readPrompt, runImplement, setupImplementHarness,
} from './support/implement-cli-harness';
import { createReporter, summarise } from './support/reporter';

const { counts, pass, fail } = createReporter();
const STEP_TEXT = 'Update repo/src/a.ts to export the regex /\\.(vue|tsx)$/';

const flatPlanFixture = {
  action: 'fix',
  summary: 'Match component files',
  steps: [STEP_TEXT],
  estimatedComplexity: 'low',
  affectedFiles: ['repo/src/a.ts'],
  affectedRepositories: ['repo'],
  risks: [],
};

const assert = (label: string, condition: boolean, detail?: string): void =>
  condition ? pass(label) : fail(label, detail);

const runScenario = (): void => {
  const harness = setupImplementHarness('wf-legacy-flat-', 'noop', ['src/a.ts']);
  try {
    fs.writeFileSync(harness.planPath, JSON.stringify(flatPlanFixture), 'utf-8');
    const { exitCode, output } = runImplement(harness);
    assert('compiled issue:implement exits successfully on a flat-steps artifact', exitCode === 0, output.slice(-800));
    assert('step text reaches the implementer prompt', readPrompt(harness, 1).includes(STEP_TEXT));
  } finally {
    cleanupHarness(harness);
  }
};

const failMissingDist = (): never => {
  fail('dist/main.js must exist', 'Run `yarn build` first.');
  return process.exit(1);
};

const main = (): void => {
  console.log(chalk.bold.cyan('\n  legacy flat-steps plan compat smoke test\n'));
  if (!fs.existsSync(distMainPath)) failMissingDist();
  runScenario();
  summarise(counts);
};

main();
