/**
 * Manual smoke test: an assessor reply that renumbers a subset from 0 fails the round and retries instead of
 *   fabricating not-done fallbacks
 *
 * Run (after `yarn build`): nr test:manual step-verify-renumbered-response-fails-loudly.smoke
 *
 * Scenario: `issue:implement` on a 10-step plan in push mode. The fake claude leaves 5, 6, 8, 9 not-done in round 1,
 *   then answers
 * every later assessor call with indices 0-3 (the incident's renumbered reply).
 *
 * Config under test:
 *   stages: { implement: { provider: 'anthropic', backend: 'cli', planStepVerification: { mode: 'push', stallWindow:
 *   2 } } }
 *
 * Verify:
 *   1. The log records attempt-failed with the returned and expected indices.
 *   2. The log records step-verify.assess.invalid and step-verify.exhausted.
 *   3. No missing-index anomaly and no step-verify.missed line is logged.
 *   4. No fix-pass prompt carries the 'Not assessed in this round' fallback text.
 *   5. The CLI exits 0 without hanging.
 *
 * Wire up: support/implement-cli-harness.ts (assessorRenumber mode) and support/step-verify-scenario.ts; needs `yarn
 *   build`.
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
  assert('attempt-failed names returned and expected indices',
    run.log.includes('Assessor returned indices [0,1,2,3] but expected [5,6,8,9]'), run.log.slice(-800));
  assert('attempt consumed twice', countOccurrences(run.log, 'step-verify.assess.attempt-failed') >= 2);
  assert('round reported invalid', run.log.includes('step-verify.assess.invalid'));
  assert('verification exhausted', run.log.includes('step-verify.exhausted'));
  assert('no missing-index anomaly', run.log.includes('missing-index=') === false);
  assert('no step-verify.missed line', run.log.includes('step-verify.missed') === false);
  assert('no fabricated fallback in fix prompts',
    run.fixPrompts.every(prompt => prompt.includes('Not assessed in this round') === false));
  assert('CLI exits 0', run.result.exitCode === 0, String(run.result.exitCode));
};

const verifyScenario = (): void => {
  const run = runStepVerifyScenario('assessorRenumber', 10, { mode: 'push', stallWindow: 2 });
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
  console.log(chalk.bold.cyan('\n  Step-verify renumbered response — live smoke test\n'));
  const run = fs.existsSync(distMainPath) ? verifyScenario : failMissingDist;
  run();
};

main();
