/**
 * Manual smoke test: a plan artifact carrying the retired stepIntents field is rejected
 * loudly by the compiled CLI with a migration hint — stepIntents plans were all migrated
 * to combined step objects and the format is no longer accepted.
 *
 * Run (after `yarn build`): nr test:manual retired-step-intents-rejection.smoke
 *
 * Verifies:
 *   1. compiled issue:implement exits non-zero on a stepIntents artifact
 *   2. the output names the retired format and tells the user how to migrate
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

const retiredPlanFixture = {
  action: 'fix',
  summary: 'Retired format fixture',
  steps: ['Update repo/src/a.ts'],
  stepIntents: ['goal a'],
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
    'output names the retired stepIntents format',
    output.includes('retired stepIntents format'),
    output.slice(-800),
  );
  assert('output contains the artifact path', output.includes(harness.planPath), output.slice(-400));
  assert('stubbed provider was never spawned', countSpawns(harness) === 0, `spawns=${countSpawns(harness)}`);
};

const runScenario = (): void => {
  const harness = setupImplementHarness('wf-retired-intents-', 'noop', ['src/a.ts']);
  try {
    fs.writeFileSync(harness.planPath, JSON.stringify(retiredPlanFixture), 'utf-8');
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
  console.log(chalk.bold.cyan('\n  retired stepIntents rejection smoke test\n'));
  if (!fs.existsSync(distMainPath)) failMissingDist();
  runScenario();
  summarise(counts);
};

main();
