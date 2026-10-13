/**
 * Manual smoke test: when the assessor omits exactly one expected index, wf falls back to not-done for it without
 *   consuming a retry
 *
 * Run (after `yarn build`): nr test:manual step-verify-partial-omission-keeps-fallback.smoke
 *
 * Scenario: `issue:implement` on a 10-step plan in push mode. Round 1 leaves 5, 6, 8, 9 not-done; the round-2 reply
 *   omits index 9;
 * later replies answer everything shown.
 *
 * Config under test:
 *   stages: { implement: { provider: 'anthropic', backend: 'cli', planStepVerification: { mode: 'push', stallWindow:
 *   3 } } }
 *
 * Verify:
 *   1. The log contains 'step-verify.assess.partial missing-index=9'.
 *   2. The log contains no attempt-failed line.
 *   3. The fix-pass prompt after round 2 carries 'Step 9 (not-done)' and the 'Not assessed in this round' text.
 *   4. Exactly three assessor prompts were sent (one per round, no retry).
 *   5. The run completes with pending=0 and exit 0.
 *
 * Wire up: support/implement-cli-harness.ts (assessorOmitOne mode) and support/step-verify-scenario.ts; needs `yarn
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
  assert('missing-index=9 logged', run.log.includes('step-verify.assess.partial missing-index=9'));
  assert('no attempt-failed line', run.log.includes('step-verify.assess.attempt-failed') === false);
  const fallbackPrompt = run.fixPrompts.find(prompt => prompt.includes('Verification round 2')) ?? '';
  assert('round-2 fix prompt lists step 9 as not-done', fallbackPrompt.includes('Step 9 (not-done)'), fallbackPrompt);
  assert('round-2 fix prompt carries the fallback text', fallbackPrompt.includes('Not assessed in this round'));
  assert('three assessor prompts, no retry', run.assessorPrompts.length === 3, String(run.assessorPrompts.length));
  assert('run completes with pending=0', run.log.includes('step-verify.complete') && run.log.includes('pending=0'));
  assert('CLI exits 0', run.result.exitCode === 0, String(run.result.exitCode));
};

const verifyScenario = (): void => {
  const run = runStepVerifyScenario('assessorOmitOne', 10, { mode: 'push', stallWindow: 3 });
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
  console.log(chalk.bold.cyan('\n  Step-verify partial omission — live smoke test\n'));
  const run = fs.existsSync(distMainPath) ? verifyScenario : failMissingDist;
  run();
};

main();
