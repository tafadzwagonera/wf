/**
 * Manual smoke test: the implement CLI attributes verification pass/fail lines to the Bash
 * command that produced the result (tool_use_id pairing), not to the most recent Bash command.
 *
 * Run (after `yarn build`): nr test:manual implement-verification-result-attribution.smoke
 *
 * Overlap note: claude-cli.adapter.spec.ts covers the pairing logic in isolation; this smoke
 * test proves the same stream shape through dist/ and the real spawn path.
 *
 * Verifies:
 *   1. compiled issue:implement exits 0
 *   2. the failing result is attributed to `bash -c "broken"`
 *   3. the passing result is attributed to `git status`
 *   4. no "Verification failed: git status" line is printed
 */
import * as fs from 'node:fs';
import chalk from 'chalk';
import {
  cleanupHarness, distMainPath, runImplement, setupImplementHarness,
} from './support/implement-cli-harness';
import { createReporter, summarise } from './support/reporter';

const { counts, pass, fail } = createReporter();

const assert = (label: string, condition: boolean, detail?: string): void =>
  condition ? pass(label) : fail(label, detail);

const assertAttribution = (exitCode: number | null, output: string): void => {
  assert('compiled issue:implement exits successfully', exitCode === 0, output.slice(-800));
  assert(
    'failing result is attributed to the broken command',
    output.includes('Verification failed: bash -c "broken"'),
    output.slice(-800),
  );
  assert('passing result is attributed to git status', output.includes('Verification passed: git status'));
  assert('git status is never reported as failed', !output.includes('Verification failed: git status'));
};

const runScenario = (): void => {
  const harness = setupImplementHarness('wf-result-attribution-', 'interleavedToolResults', ['src/a.ts']);
  try {
    const { exitCode, output } = runImplement(harness);
    assertAttribution(exitCode, output);
  } finally {
    cleanupHarness(harness);
  }
};

const failMissingDist = (): never => {
  fail('dist/main.js must exist', 'Run `yarn build` first.');
  return process.exit(1);
};

const main = (): void => {
  console.log(chalk.bold.cyan('\n  verification result attribution smoke test\n'));
  if (!fs.existsSync(distMainPath)) failMissingDist();
  runScenario();
  summarise(counts);
};

main();
