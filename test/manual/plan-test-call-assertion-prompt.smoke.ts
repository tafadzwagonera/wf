/**
 * Manual smoke test: the issue:plan prompt tells the planner to assert that mocked collaborators were called after
 * the act step, both in the plan step principles and in the detected test conventions
 *
 * Run (after `yarn build`): nr test:manual plan-test-call-assertion-prompt.smoke
 *
 * Scenario: `node dist/main.js issue:plan --action fix --custom-plan source.md --silent` with the plan stage on the
 * claude CLI backend, in a temp repo with a jest package.json and a spec file under src/. A fake `claude` records its
 * argv and stdin prompt, then returns a minimal valid plan whose step names no mock.
 *
 * Config under test:
 *   stages: { plan: { provider: 'anthropic', backend: 'cli' } }
 *
 * Verify:
 *   1. The command exits 0 and writes a plan artifact under the isolated HOME.
 *   2. The prompt carries the plan step principles bullet about asserting mocked collaborators were called.
 *   3. The prompt carries the "Mocked collaborators:" test-conventions line.
 *   4. The conventions line sits before "Follow these patterns when prescribing test changes."
 *   5. In a repo without spec files the principles bullet remains, the conventions line is absent, and exit is 0.
 *
 * Wire up: support/plan-cli-harness.ts (temp repo, fake `claude` on PATH, isolated HOME); requires `yarn build`.
 * Teardown: the temp roots (repo, bin, home, prompts) are removed.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import chalk from 'chalk';
import {
  cleanupPlanHarness, distMainPath, readPlanPrompt, runPlan, setupPlanHarness, type PlanHarness,
} from './support/plan-cli-harness';
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

const principlesBullet = 'when a collaborator is mocked, also assert after the act';
const principlesTail = 'that it was called and with what arguments';
const conventionsLine = 'Mocked collaborators: assert after the act step that the collaborator was called';
const conventionsTail = 'never assert only inside a mock callback';
const conventionsClosing = 'Follow these patterns when prescribing test changes.';

const baseFiles = {
  'package.json': JSON.stringify({ scripts: { test: 'jest' }, devDependencies: { jest: '^30.0.0' } }),
  'src/a.ts': 'export {};\n',
};
const specFiles = { ...baseFiles, 'src/a.spec.ts': 'describe("a", () => { it("works", () => {}); });\n' };

const artifactCount = (harness: PlanHarness): number => {
  const dir = path.join(harness.homeDir, '.wf', 'repo');
  return fs.existsSync(dir) ? fs.readdirSync(dir).length : 0;
};

const runPrompt = (
  prefix: string, files: Record<string, string>, check: (prompt: string, harness: PlanHarness) => void,
): void => {
  const harness = setupPlanHarness(prefix, plan, files);
  try {
    const { exitCode, output } = runPlan(harness);
    assert('command exits 0', exitCode === 0, output.slice(-600));
    check(readPlanPrompt(harness, 1), harness);
  } finally {
    cleanupPlanHarness(harness);
  }
};

function verifyRepoWithSpecs(): void {
  runPrompt('wf-call-assert-prompt-', specFiles, (prompt, harness) => {
    assert('plan artifact was written', artifactCount(harness) > 0);
    assert('principles bullet is in the prompt', prompt.includes(principlesBullet), prompt.slice(0, 400));
    assert('principles bullet asks for call arguments', prompt.includes(principlesTail));
    assert('conventions line is in the prompt', prompt.includes(conventionsLine));
    assert('conventions line forbids asserting only in a callback', prompt.includes(conventionsTail));
    const lineIndex = prompt.indexOf(conventionsLine);
    assert('conventions line precedes the closing instruction', lineIndex >= 0 && lineIndex < prompt.indexOf(conventionsClosing));
  });
}

function verifyRepoWithoutSpecs(): void {
  runPrompt('wf-call-assert-nospec-', baseFiles, prompt => {
    assert('principles bullet remains without specs', prompt.includes(principlesBullet));
    assert('conventions line is absent without specs', !prompt.includes(conventionsLine));
  });
}

const failMissingDist = (): never => {
  fail('dist/main.js must exist', 'Run `yarn build` first.');
  return process.exit(1);
};

function verifyPrompts(): void {
  verifyRepoWithSpecs();
  verifyRepoWithoutSpecs();
  summarise(counts);
}

function main(): void {
  console.log(chalk.bold.cyan('\n  Plan test call-assertion prompt — live smoke test\n'));
  const run = fs.existsSync(distMainPath) ? verifyPrompts : failMissingDist;
  run();
}

main();
