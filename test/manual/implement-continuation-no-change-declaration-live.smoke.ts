/**
 * Manual smoke test: a `NO-CHANGE: <path>` line removes the file from the unvisited set and appears in the file summary
 *
 * Run: nr test:manual implement-continuation-no-change-declaration-live.smoke
 *
 * Scenario: `issue:implement` on the claude CLI backend with planned files src/a.ts and src/b.ts. The fake claude
 * edits nothing on the initial run, then declares both files NO-CHANGE (plus an unplanned file) on the first
 * continuation pass. A second run declares src/a.ts NO-CHANGE but really edits it.
 *
 * Config under test:
 *   stages: { implement: { provider: 'anthropic', backend: 'cli' } }
 *
 * Verify:
 *   1. Declare-only run: 2 spawns, both planned files listed as "no change required (agent-declared)".
 *   2. Declare-only run: no no-op stop log, no "updated: src/a.ts", unplanned declaration ignored.
 *   3. The continuation prompt tells the agent to emit `NO-CHANGE: <path>`.
 *   4. Declared-and-edited run: src/a.ts is reported as "updated" and not as agent-declared.
 *
 * Wire up: temp git repo plus fake `claude` on PATH (support/implement-cli-harness.ts); requires `yarn build`.
 * Teardown: the temp roots are removed.
 */
import * as fs from 'node:fs';
import chalk from 'chalk';
import {
  cleanupHarness, countSpawns, distMainPath, readPrompt, runImplement, setupImplementHarness,
  type FakeClaudeMode,
} from './support/implement-cli-harness';
import { createReporter, summarise } from './support/reporter';

const { counts, pass, fail } = createReporter();

const assert = (label: string, condition: boolean, detail?: string): void =>
  condition ? pass(label) : fail(label, detail);

const plannedFiles = ['src/a.ts', 'src/b.ts'];
const declaredLine = (file: string): string => `no change required (agent-declared): ${file}`;

const runScenario = (mode: FakeClaudeMode): { output: string; spawns: number; prompt: string } => {
  const harness = setupImplementHarness(`wf-no-change-${mode}-`, mode, plannedFiles);
  try {
    const { output } = runImplement(harness);
    return { output, spawns: countSpawns(harness), prompt: readPrompt(harness, 2) };
  } finally {
    cleanupHarness(harness);
  }
};

function verifyDeclareOnly(): void {
  const { output, spawns, prompt } = runScenario('declare');
  assert('declare-only run spawns the agent exactly twice', spawns === 2, `spawns=${spawns}`);
  assert('src/a.ts listed as agent-declared', output.includes(declaredLine('src/a.ts')), output.slice(-800));
  assert('src/b.ts listed as agent-declared', output.includes(declaredLine('src/b.ts')));
  assert('unplanned declaration is ignored', !output.includes(declaredLine('src/other.ts')));
  assert('no-op stop log did not fire', !output.includes('No file changes across 2 passes'));
  assert('declared file is not reported as updated', !output.includes('updated: src/a.ts'));
  assert('continuation prompt carries the NO-CHANGE instruction', prompt.includes('include a line `NO-CHANGE: <path>`'));
  assert('continuation prompt offers the declare option', prompt.includes('declare it NO-CHANGE'));
}

function verifyDeclareFormatted(): void {
  const { output, spawns } = runScenario('declareFormatted');
  assert('formatted-declaration run spawns the agent exactly twice', spawns === 2, `spawns=${spawns}`);
  assert('bold declaration for src/a.ts is accepted', output.includes(declaredLine('src/a.ts')), output.slice(-800));
  assert('quoted declaration with trailing period for src/b.ts is accepted', output.includes(declaredLine('src/b.ts')));
}

function verifyDeclareAndEdit(): void {
  const { output } = runScenario('declareAndEdit');
  assert('declared-and-edited file is reported as updated', output.includes('updated: src/a.ts'), output.slice(-800));
  assert('declared-and-edited file is not reported as agent-declared', !output.includes(declaredLine('src/a.ts')));
}

function runChecks(): void {
  verifyDeclareOnly();
  verifyDeclareFormatted();
  verifyDeclareAndEdit();
  summarise(counts);
}

const failMissingDist = (): never => {
  fail('dist/main.js must exist', 'Run `yarn build` first.');
  return process.exit(1);
};

function main(): void {
  console.log(chalk.bold.cyan('\n  Implement NO-CHANGE declaration — live smoke test\n'));
  const run = fs.existsSync(distMainPath) ? runChecks : failMissingDist;
  run();
}

main();
