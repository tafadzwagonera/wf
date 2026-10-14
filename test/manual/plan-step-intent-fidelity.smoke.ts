import * as fs from 'node:fs';
import chalk from 'chalk';
import {
  cleanupHarness, countSpawns, distMainPath, readPrompt, runImplement, setupImplementHarness,
} from './support/implement-cli-harness';
import { createReporter, summarise } from './support/reporter';

const { counts, pass, fail } = createReporter();
const INTENT_TEXT = 'only vue and tsx files are matched';
const DOWNGRADE_RULE = 'a literal that differs from the diff is a "warning", not an "error"';

const planFixture = {
  action: 'fix',
  summary: 'Match component files',
  steps: ['Update repo/src/a.ts to export the regex /\\.(vue|tsx)$/'],
  stepIntents: [INTENT_TEXT],
  estimatedComplexity: 'medium',
  affectedFiles: ['repo/src/a.ts'],
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
  assert('fidelity prompt contains the intent text', prompt.includes(INTENT_TEXT));
  assert('fidelity prompt contains the downgrade rule', prompt.includes(DOWNGRADE_RULE));
};

const runScenario = (): void => {
  const harness = setupImplementHarness('wf-step-intent-', 'intentFidelity', ['src/a.ts'], {
    stepVerification: { mode: 'pull', provider: 'anthropic', model: 'claude-sonnet-4-6', backend: 'cli' },
    estimatedComplexity: 'medium',
  });
  try {
    fs.writeFileSync(harness.planPath, JSON.stringify(planFixture), 'utf-8');
    const result = runImplement(harness);
    const prompts = fidelityPrompts(countSpawns(harness), callNumber => readPrompt(harness, callNumber));
    assertRunResult(result.exitCode, result.output, prompts);
  } finally {
    cleanupHarness(harness);
  }
};

const failMissingDist = (): never => {
  fail('dist/main.js must exist', 'Run `nr build` first.');
  return process.exit(1);
};

const main = (): void => {
  console.log(chalk.bold.cyan('\n  plan step intent fidelity smoke test\n'));
  if (!fs.existsSync(distMainPath)) failMissingDist();
  runScenario();
  summarise(counts);
};

main();
