/**
 * Manual smoke test: in pull mode, an assessor reply whose statuses are all out of scope fails the attempt instead of
 *   fabricating not-done
 *
 * Run (after `yarn build`): nr test:manual step-verify-pull-all-dropped-fails-loudly.smoke
 *
 * Scenario: `issue:implement` with planStepVerification.mode 'pull' on a 3-step plan. Every assessor reply contains
 *   only index 9.
 *
 * Config under test:
 *   stages: { implement: { provider: 'anthropic', backend: 'cli', planStepVerification: { mode: 'pull', stallWindow:
 *   1 } } }
 *
 * Verify:
 *   1. The log contains 'step-verify.mode=pull' and 'dropped-index=9'.
 *   2. The log contains the zero-accepted error at least twice.
 *   3. The log contains step-verify.exhausted and no step-verify.missed line.
 *   4. No fix-pass prompt carries the 'Not assessed in this round' fallback text.
 *
 * Wire up: support/implement-cli-harness.ts (assessorPullOutOfScope mode) and support/step-verify-scenario.ts; needs
 *   `yarn build`.
 * Teardown: the temp root is removed.
 */
import * as fs from 'node:fs';
import chalk from 'chalk';
import { cleanupHarness, distMainPath } from './support/implement-cli-harness';
import { createReporter, summarise } from './support/reporter';
import { countOccurrences, runStepVerifyScenario, type StepVerifyRun } from './support/step-verify-scenario';

const { counts, pass, fail } = createReporter();

const assert = (label: string, condition: boolean, detail?: string): void =>
  condition ? pass(label) : fail(label, detail);

const verifyRun = (run: StepVerifyRun): void => {
  assert('pull mode selected', run.log.includes('step-verify.mode=pull'), run.log.slice(-800));
  assert('dropped-index=9 logged', run.log.includes('dropped-index=9'));
  assert('zero-accepted error raised on each attempt',
    countOccurrences(run.log, 'Assessor response accepted zero of 3 expected step indices') >= 2);
  assert('verification exhausted', run.log.includes('step-verify.exhausted'));
  assert('no step-verify.missed line', run.log.includes('step-verify.missed') === false);
  assert('no fabricated fallback in fix prompts',
    run.fixPrompts.every(prompt => prompt.includes('Not assessed in this round') === false));
};

const verifyScenario = (): void => {
  const run = runStepVerifyScenario('assessorPullOutOfScope', 3, { mode: 'pull', stallWindow: 1 });
  try {
    verifyRun(run);
  } finally {
    cleanupHarness(run.harness);
  }
  summarise(counts);
};

const failMissingDist = (): never => {
  fail('dist/main.js must exist', 'Run `yarn build` first.');
  return process.exit(1);
};

const main = (): void => {
  console.log(chalk.bold.cyan('\n  Step-verify pull all-dropped — live smoke test\n'));
  const run = fs.existsSync(distMainPath) ? verifyScenario : failMissingDist;
  run();
};

main();
