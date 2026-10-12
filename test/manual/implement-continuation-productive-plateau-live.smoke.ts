/**
 * Manual smoke test: a continuation loop that keeps writing files is not cut off by the no-op rule
 *
 * Run: nr test:manual implement-continuation-productive-plateau-live.smoke
 *
 * Scenario: `issue:implement` on the claude CLI backend with a 15-file plan; the fake claude writes an unplanned
 * file on every continuation pass, so passes change files but the planned workload never drops. The no-op cutoff
 * must not fire; the scaled workload stall (threshold 3 for 15 files) must end the loop.
 *
 * Config under test:
 *   stages: { implement: { provider: 'anthropic', backend: 'cli' } }
 *
 * Verify:
 *   1. The fake claude is spawned exactly 4 times (initial run plus 3 continuation passes).
 *   2. Output contains "Workload not decreasing after 3 passes — stopping".
 *   3. Output does not contain "No file changes across 2 passes".
 *
 * Wire up: temp git repo plus fake `claude` on PATH (support/implement-cli-harness.ts); requires `yarn build`.
 * Teardown: the temp root is removed.
 */
import * as fs from 'node:fs';
import chalk from 'chalk';
import {
  cleanupHarness, countSpawns, distMainPath, runImplement, setupImplementHarness, type ImplementHarness,
} from './support/implement-cli-harness';
import { createReporter, summarise } from './support/reporter';

const { counts, pass, fail } = createReporter();

const assert = (label: string, condition: boolean, detail?: string): void =>
  condition ? pass(label) : fail(label, detail);

const plannedFiles = Array.from({ length: 15 }, (_, i) => `src/file-${i}.ts`);

function verifyPlateau(harness: ImplementHarness): void {
  const { output } = runImplement(harness);
  const spawns = countSpawns(harness);
  assert('fake claude spawned exactly 4 times', spawns === 4, `spawns=${spawns}`);
  assert('workload stall ends the loop', output.includes('Workload not decreasing after 3 passes — stopping'), output.slice(-800));
  assert('no-op cutoff did not fire', !output.includes('No file changes across 2 passes'));
}

function main(): void {
  console.log(chalk.bold.cyan('\n  Implement productive plateau — live smoke test\n'));
  if (!fs.existsSync(distMainPath)) {
    fail('dist/main.js must exist', 'Run `yarn build` first.');
    process.exit(1);
  }
  const harness = setupImplementHarness('wf-plateau-', 'writeEachPass', plannedFiles);
  try {
    verifyPlateau(harness);
  } finally {
    cleanupHarness(harness);
  }
  summarise(counts);
}

main();
