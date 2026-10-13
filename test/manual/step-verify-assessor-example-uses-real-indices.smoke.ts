/**
 * Manual smoke test: a later-round step-verify assessor prompt renders its response example from the real
 * [Plan step N] indices and forbids renumbering
 *
 * Run (after `yarn build`): nr test:manual step-verify-assessor-example-uses-real-indices.smoke
 *
 * Scenario: `node dist/main.js issue:implement <plan> --silent --no-branch --skip-install` on a 10-step plan with
 * planStepVerification in push mode. A fake `claude` leaves steps 5, 6, 8 and 9 not-done in round 1 and answers
 * later assessor calls with the indices it was shown. The round-2 assessor prompt is the observable.
 *
 * Config under test:
 *   stages: { implement: { provider: 'anthropic', backend: 'cli', planStepVerification: { mode: 'push', stallWindow:
 *   3 } } }
 *
 * Verify:
 *   1. The round-1 prompt renders the example from indices 0 and 1.
 *   2. The round-2 prompt renders the example from indices 5 and 6.
 *   3. The round-2 prompt carries the never-renumber sentence.
 *   4. The round-2 prompt does not render an index-0 example.
 *   5. The agent log has no dropped-index anomalies.
 *
 * Wire up: support/implement-cli-harness.ts (assessorProbe mode) and support/step-verify-scenario.ts.
 * Teardown: the temp root is removed.
 */
import * as fs from 'node:fs';
import chalk from 'chalk';
import { cleanupHarness, distMainPath } from './support/implement-cli-harness';
import { createReporter, summarise } from './support/reporter';
import { runStepVerifyScenario } from './support/step-verify-scenario';

const { counts, pass, fail } = createReporter();

const assert = (label: string, condition: boolean, detail?: string): void =>
  condition ? pass(label) : fail(label, detail);

const ROUND_ONE_EXAMPLE = '{"index":0,"status":"done"},{"index":1,"status":"partially-done"';
const ROUND_TWO_EXAMPLE = '{"index":5,"status":"done"},{"index":6,"status":"partially-done"';
const NEVER_RENUMBER = 'Use the exact N from each [Plan step N] tag — never renumber from 0.';

const verifyExamples = (): void => {
  const run = runStepVerifyScenario('assessorProbe', 10, { mode: 'push', stallWindow: 3 });
  try {
    const [roundOne = '', roundTwo = ''] = run.assessorPrompts;
    assert('round 1 example uses indices 0 and 1', roundOne.includes(ROUND_ONE_EXAMPLE), roundOne.slice(-400));
    assert('round 2 example uses indices 5 and 6', roundTwo.includes(ROUND_TWO_EXAMPLE), roundTwo.slice(-400));
    assert('round 2 carries the never-renumber sentence', roundTwo.includes(NEVER_RENUMBER));
    assert('round 2 has no index-0 example', roundTwo.length > 0 && roundTwo.includes('{"index":0,"status":"done"}') === false);
    assert('log has no dropped-index anomalies', run.log.includes('dropped-index') === false, run.log.slice(-600));
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
  console.log(chalk.bold.cyan('\n  Step-verify assessor example indices — live smoke test\n'));
  const run = fs.existsSync(distMainPath) ? verifyExamples : failMissingDist;
  run();
};

main();
