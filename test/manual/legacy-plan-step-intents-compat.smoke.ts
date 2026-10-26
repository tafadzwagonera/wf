/**
 * Manual smoke test: a legacy plan artifact (flat string steps + index-aligned stepIntents)
 * still implements correctly through the compiled CLI, with its intent reaching the
 * spec-fidelity prompt.
 *
 * Run (after `yarn build`): nr test:manual legacy-plan-step-intents-compat.smoke
 *
 * Overlap note: plan-step-intent-fidelity.smoke.ts covers the canonical combined step shape
 * ({ description, intent }); this test covers the legacy backward-compat path for the same
 * observable behavior.
 *
 * Verifies:
 *   1. compiled issue:implement exits 0 on a legacy-shaped plan artifact
 *   2. the stubbed provider received exactly one fidelity prompt
 *   3. the fidelity prompt contains the legacy intent text (zipped onto its step on load)
 *   4. the fidelity prompt contains the intent downgrade rule
 */
import * as fs from 'node:fs';
import chalk from 'chalk';
import {
  cleanupHarness, countSpawns, distMainPath, readPrompt, runImplement, setupImplementHarness,
} from './support/implement-cli-harness';
import { createReporter, summarise } from './support/reporter';

const { counts, pass, fail } = createReporter();
const INTENT_TEXT = 'only vue and tsx files are matched';
const DOWNGRADE_RULE = 'a literal that differs from the diff is a "warning", not an "error"';

const legacyPlanFixture = {
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
  assert('compiled issue:implement exits successfully on a legacy artifact', exitCode === 0, output.slice(-800));
  assert('stubbed provider received one fidelity prompt', prompts.length === 1, `calls=${prompts.length}`);
  assert('fidelity prompt contains the legacy intent text', prompt.includes(INTENT_TEXT));
  assert('fidelity prompt contains the downgrade rule', prompt.includes(DOWNGRADE_RULE));
};

const runScenario = (): void => {
  const harness = setupImplementHarness('wf-legacy-intents-', 'intentFidelity', ['src/a.ts'], {
    stepVerification: { mode: 'pull', provider: 'anthropic', model: 'claude-sonnet-4-6', backend: 'cli' },
    estimatedComplexity: 'medium',
  });
  try {
    fs.writeFileSync(harness.planPath, JSON.stringify(legacyPlanFixture), 'utf-8');
    const result = runImplement(harness);
    const prompts = fidelityPrompts(countSpawns(harness), callNumber => readPrompt(harness, callNumber));
    assertRunResult(result.exitCode, result.output, prompts);
  } finally {
    cleanupHarness(harness);
  }
};

const failMissingDist = (): never => {
  fail('dist/main.js must exist', 'Run `yarn build` first.');
  return process.exit(1);
};

const main = (): void => {
  console.log(chalk.bold.cyan('\n  legacy plan stepIntents compat smoke test\n'));
  if (!fs.existsSync(distMainPath)) failMissingDist();
  runScenario();
  summarise(counts);
};

main();
