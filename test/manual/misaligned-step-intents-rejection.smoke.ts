/**
 * Manual smoke test: a legacy plan artifact whose stepIntents length differs from steps is
 * rejected loudly by the compiled CLI instead of being silently zipped.
 *
 * Run (after `yarn build`): nr test:manual misaligned-step-intents-rejection.smoke
 *
 * Verifies:
 *   1. compiled issue:implement exits non-zero on a misaligned legacy artifact
 *   2. the output names the counts: "Plan file has 2 stepIntents for 1 steps"
 *   3. the output contains the artifact path so the user can find the file
 *   4. the stubbed provider was never spawned — the run aborted before implementation work
 */
import * as fs from 'node:fs';
import chalk from 'chalk';
import {
  cleanupHarness, countSpawns, distMainPath, runImplement, setupImplementHarness,
} from './support/implement-cli-harness';
import { createReporter, summarise } from './support/reporter';

const { counts, pass, fail } = createReporter();

const misalignedPlanFixture = {
  action: 'fix',
  summary: 'Mismatch fixture',
  steps: ['Update repo/src/a.ts'],
  stepIntents: ['goal a', 'goal b'],
  estimatedComplexity: 'medium',
  affectedFiles: ['repo/src/a.ts'],
  affectedRepositories: ['repo'],
  risks: [],
};

const assert = (label: string, condition: boolean, detail?: string): void =>
  condition ? pass(label) : fail(label, detail);

const assertRejectedLoudly = (
  harness: ReturnType<typeof setupImplementHarness>,
  exitCode: number | null,
  output: string,
): void => {
  assert('compiled issue:implement exits non-zero', exitCode !== 0 && exitCode !== null, `exitCode=${exitCode}`);
  assert(
    'output names the mismatched counts',
    output.includes('Plan file has 2 stepIntents for 1 steps'),
    output.slice(-800),
  );
  assert('output contains the artifact path', output.includes(harness.planPath), output.slice(-400));
  assert('stubbed provider was never spawned', countSpawns(harness) === 0, `spawns=${countSpawns(harness)}`);
};

const runScenario = (): void => {
  const harness = setupImplementHarness('wf-misaligned-intents-', 'noop', ['src/a.ts']);
  try {
    fs.writeFileSync(harness.planPath, JSON.stringify(misalignedPlanFixture), 'utf-8');
    const { exitCode, output } = runImplement(harness);
    assertRejectedLoudly(harness, exitCode, output);
  } finally {
    cleanupHarness(harness);
  }
};

const failMissingDist = (): never => {
  fail('dist/main.js must exist', 'Run `yarn build` first.');
  return process.exit(1);
};

const main = (): void => {
  console.log(chalk.bold.cyan('\n  misaligned stepIntents rejection smoke test\n'));
  if (!fs.existsSync(distMainPath)) failMissingDist();
  runScenario();
  summarise(counts);
};

main();
