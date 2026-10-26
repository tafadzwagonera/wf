/**
 * Manual smoke test: the plan prompt delivered to the backend contains the sub-agent delegation
 * guidance scoped to multi-repo/multi-area tickets, with the file:line evidence requirement
 *
 * Run (after `yarn build`): nr test:manual plan-subagent-prompt-guidance.smoke
 *
 * Scenario: `node dist/main.js issue:plan --action fix --custom-plan <source.md> --silent` with the
 * plan stage on the claude CLI backend and a temp git repo. A fake `claude` records the plan turn's
 * argv and stdin prompt, then returns a minimal valid plan.
 *
 * Config under test:
 *   stages: { plan: { provider: 'anthropic', backend: 'cli' } }
 *
 * Verify:
 *   1. The plan command exits 0.
 *   2. The plan-turn prompt contains the "Sub-agent delegation" section.
 *   3. It scopes delegation to tickets spanning "multiple repositories or distinct areas".
 *   4. It names the three verification threads: reuse-candidate scope, call sites and consumers,
 *      and cited repository conventions.
 *   5. It requires file:line evidence and discards unevidenced claims.
 *   6. It carries the inline fallback clause for single-repo, single-area tickets.
 *   7. The section sits after the verification principles block and before "Return ONLY a valid
 *      JSON object" (the plan JSON schema example).
 *
 * Wire up: support/plan-cli-harness.ts (temp git repo, fake `claude` on PATH, isolated HOME);
 * requires `yarn build`.
 * Teardown: the harness temp root (repo, bin, home, prompts) is removed.
 */
import * as fs from 'node:fs';
import chalk from 'chalk';
import { cleanupPlanHarness, distMainPath, readPlanPrompt, runPlan, setupPlanHarness } from './support/plan-cli-harness';
import { createReporter, summarise } from './support/reporter';

const { counts, pass, fail } = createReporter();

const assert = (label: string, condition: boolean, detail?: string): void =>
  condition ? pass(label) : fail(label, detail);

const plan = {
  action: 'fix',
  summary: 'Smoke plan',
  steps: ['Add a note to repo/src/a.ts.'],
  estimatedComplexity: 'low',
  affectedFiles: [{ filePath: 'repo/src/a.ts', status: 'found' }],
  affectedRepositories: ['repo'],
  risks: [],
};

function verifyGuidanceContent(prompt: string): void {
  assert('prompt contains the Sub-agent delegation section', prompt.includes('Sub-agent delegation'),
    prompt.slice(0, 400));
  assert('prompt scopes delegation to multi-repo/multi-area tickets',
    prompt.includes('multiple repositories or distinct areas'));
  assert('prompt names reuse-candidate verification', prompt.includes('reuse candidate'));
  assert('prompt names call site and consumer tracing', prompt.includes('call sites and consumers'));
  assert('prompt names repository convention verification', prompt.includes('repository conventions'));
  assert('prompt requires file:line evidence', prompt.includes('file:line'));
  assert('prompt discards unevidenced claims', prompt.includes('discard unevidenced claims'));
  assert('prompt carries the single-repo fallback clause', prompt.includes('single-repo, single-area ticket'));
}

function verifyGuidancePosition(prompt: string): void {
  const verificationPosition = prompt.indexOf('Verification principles');
  const guidancePosition = prompt.indexOf('Sub-agent delegation');
  const schemaPosition = prompt.indexOf('Return ONLY a valid JSON object');
  assert('sub-agent guidance follows the verification principles',
    verificationPosition >= 0 && guidancePosition > verificationPosition,
    `verification=${verificationPosition} guidance=${guidancePosition}`);
  assert('sub-agent guidance precedes the plan JSON schema example',
    schemaPosition >= 0 && guidancePosition < schemaPosition,
    `guidance=${guidancePosition} schema=${schemaPosition}`);
}

function verifyPlanPromptGuidance(): void {
  const harness = setupPlanHarness('wf-plan-subagent-prompt-', plan, { 'src/a.ts': 'export {};\n' });
  try {
    const { exitCode, output } = runPlan(harness);
    assert('plan command exits 0', exitCode === 0, output.slice(-600));
    const prompt = readPlanPrompt(harness, 1);
    verifyGuidanceContent(prompt);
    verifyGuidancePosition(prompt);
  } finally {
    cleanupPlanHarness(harness);
  }
}

const failMissingDist = (): never => {
  fail('dist/main.js must exist', 'Run `yarn build` first.');
  return process.exit(1);
};

function main(): void {
  console.log(chalk.bold.cyan('\n  Plan sub-agent prompt guidance — smoke test\n'));
  if (!fs.existsSync(distMainPath)) failMissingDist();
  verifyPlanPromptGuidance();
  summarise(counts);
}

main();
