/**
 * Manual smoke test: the spec-fidelity pre-pass sees newly created (untracked) files — a
 * to-create step is judged against the file's content instead of a diff that lacks it.
 *
 * Run (after `yarn build`): nr test:manual fidelity-untracked-file-evidence.smoke
 *
 * Verifies:
 *   1. compiled issue:implement exits 0
 *   2. exactly one fidelity prompt was sent to the stubbed provider
 *   3. the fidelity prompt carries the "New untracked files" evidence heading
 *   4. the fidelity prompt contains the untracked file's path and its content literal
 */
import * as fs from 'node:fs';
import chalk from 'chalk';
import {
  cleanupHarness, countSpawns, distMainPath, readPrompt, runImplement, setupImplementHarness,
} from './support/implement-cli-harness';
import { createReporter, summarise } from './support/reporter';

const { counts, pass, fail } = createReporter();

const planFixture = {
  action: 'fix',
  summary: 'Create the release helper script',
  steps: [{
    description: 'Update repo/src/a.ts and create repo/scripts/new-tool.sh with `set -eu`',
    intent: 'new-tool.sh runs with set -eu',
  }],
  estimatedComplexity: 'medium',
  affectedFiles: ['repo/src/a.ts', { filePath: 'repo/scripts/new-tool.sh', status: 'to-create' }],
  affectedRepositories: ['repo'],
  risks: [],
};

const assert = (label: string, condition: boolean, detail?: string): void =>
  condition ? pass(label) : fail(label, detail);

const fidelityPrompts = (promptCount: number, read: (callNumber: number) => string): string[] =>
  Array.from({ length: promptCount }, (_, index) => read(index + 1))
    .filter(prompt => prompt.includes('## Plan step') && prompt.includes('## Your task'));

const assertRunResult = (exitCode: number | null, output: string, prompts: string[]): void => {
  const prompt = prompts[0] ?? '';
  assert('compiled issue:implement exits successfully', exitCode === 0, output.slice(-800));
  assert('stubbed provider received one fidelity prompt', prompts.length === 1, `calls=${prompts.length}`);
  assert('fidelity prompt carries the untracked-evidence heading', prompt.includes('New untracked files'));
  assert(
    'fidelity prompt contains the untracked file path and content',
    prompt.includes('scripts/new-tool.sh') && prompt.includes('set -eu'),
  );
};

const runScenario = (): void => {
  const harness = setupImplementHarness('wf-untracked-fidelity-', 'untrackedFidelity', ['src/a.ts'], {
    stepVerification: { mode: 'pull', provider: 'anthropic', model: 'claude-sonnet-4-6', backend: 'cli' },
    estimatedComplexity: 'medium',
  });
  try {
    fs.writeFileSync(harness.planPath, JSON.stringify(planFixture), 'utf-8');
    const { exitCode, output } = runImplement(harness);
    const prompts = fidelityPrompts(countSpawns(harness), callNumber => readPrompt(harness, callNumber));
    assertRunResult(exitCode, output, prompts);
  } finally {
    cleanupHarness(harness);
  }
};

const failMissingDist = (): never => {
  fail('dist/main.js must exist', 'Run `yarn build` first.');
  return process.exit(1);
};

const main = (): void => {
  console.log(chalk.bold.cyan('\n  fidelity untracked-file evidence smoke test\n'));
  if (!fs.existsSync(distMainPath)) failMissingDist();
  runScenario();
  summarise(counts);
};

main();
