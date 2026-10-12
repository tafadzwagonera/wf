/**
 * Manual smoke test: the claude-cli implement continuation loop stops after 2 consecutive passes that change no files
 *
 * Run: nr test:manual implement-continuation-noop-cutoff-live.smoke
 *
 * Scenario: `node dist/main.js issue:implement <plan> --silent --no-branch --skip-install` on the claude CLI
 * backend with a 15-file plan and a fake `claude` that answers every pass without editing anything. The loop must
 * stop after 2 no-op continuation passes instead of waiting for the scaled workload stall.
 *
 * Config under test:
 *   stages: { implement: { provider: 'anthropic', backend: 'cli' } }
 *
 * Verify:
 *   1. The fake claude is spawned exactly 3 times (initial run plus 2 continuation passes).
 *   2. Output contains "No file changes across 2 passes — stopping".
 *   3. Output does not contain "Workload not decreasing".
 *   4. The first continuation prompt reports "Progress: 0/15 files modified (pass 1)" and the NO-CHANGE instruction.
 *
 * Wire up: temp git repo plus fake `claude` on PATH (support/implement-cli-harness.ts); requires `yarn build`.
 * Teardown: the temp root (repo, bin, home, prompts) is removed.
 */
import * as fs from 'node:fs';
import chalk from 'chalk';
import {
  cleanupHarness, countSpawns, distMainPath, readPrompt, runImplement, setupImplementHarness, type ImplementHarness,
} from './support/implement-cli-harness';
import { createReporter, summarise } from './support/reporter';

const { counts, pass, fail } = createReporter();

const assert = (label: string, condition: boolean, detail?: string): void =>
  condition ? pass(label) : fail(label, detail);

const plannedFiles = Array.from({ length: 15 }, (_, i) => `src/file-${i}.ts`);

function verifyNoOpCutoff(harness: ImplementHarness): void {
  const { output } = runImplement(harness);
  const spawns = countSpawns(harness);
  assert('fake claude spawned exactly 3 times (initial + 2 no-op passes)', spawns === 3, `spawns=${spawns}`);
  assert('output reports the no-op stop', output.includes('No file changes across 2 passes — stopping'), output.slice(-800));
  assert('old workload stall did not fire', !output.includes('Workload not decreasing'));
  const prompt = readPrompt(harness, 2);
  assert('continuation prompt reports progress', prompt.includes('Progress: 0/15 files modified (pass 1)'));
  assert('continuation prompt carries the NO-CHANGE instruction', prompt.includes('`NO-CHANGE: <path>`'));
}

function main(): void {
  console.log(chalk.bold.cyan('\n  Implement continuation no-op cutoff — live smoke test\n'));
  if (!fs.existsSync(distMainPath)) {
    fail('dist/main.js must exist', 'Run `yarn build` first.');
    process.exit(1);
  }
  const harness = setupImplementHarness('wf-noop-cutoff-', 'noop', plannedFiles);
  try {
    verifyNoOpCutoff(harness);
  } finally {
    cleanupHarness(harness);
  }
  summarise(counts);
}

main();
