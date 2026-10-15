/**
 * Manual smoke test: a `PLAN-PROBLEM: <step> | <reason> | <instead>` line is parsed, shown, persisted and fed back
 *
 * Run: nr test:manual implement-plan-problem-report.smoke
 *
 * Scenario: `issue:implement` on the claude CLI backend with a two-step plan. The fake claude edits src/a.ts and
 * reports a plan problem for step 1 in its final message. The fake assessor marks both steps not-done on its first
 * call and done afterwards, so one fix round runs. A second run reports a malformed line (two parts only).
 *
 * Config under test:
 *   stages: { implement: { provider: 'anthropic', backend: 'cli', planStepVerification: { mode: 'pull' } } }
 *
 * Verify:
 *   1. The terminal prints "Plan problem reported for step 1" with the reason.
 *   2. The newest implement-verification run file carries run.planProblems with the reported reason.
 *   3. The fix-round prompt shows the reported step with the report and the unreported step without it.
 *   4. A malformed PLAN-PROBLEM line prints no notice and leaves run.planProblems absent.
 *
 * Wire up: temp git repo plus fake `claude` on PATH (support/implement-cli-harness.ts); requires `yarn build`.
 * Teardown: the temp roots are removed.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import chalk from 'chalk';
import {
  cleanupHarness, distMainPath, runImplement, setupImplementHarness,
  type FakeClaudeMode, type ImplementHarness,
} from './support/implement-cli-harness';
import { createReporter, summarise } from './support/reporter';

const { counts, pass, fail } = createReporter();

const REASON = 'resolver differs from plan text';
const INSTEAD = 'matched the runtime resolver';
const REPORT_MARKER = '[IMPLEMENTER REPORTED PLAN PROBLEM';

const planFixture = {
  action: 'fix',
  summary: 'Match component files',
  steps: [
    'Update repo/src/a.ts to export the regex /\\.(vue|tsx)$/',
    'Update repo/src/a.ts to export a second constant',
  ],
  estimatedComplexity: 'medium',
  affectedFiles: ['repo/src/a.ts'],
  affectedRepositories: ['repo'],
  risks: [],
};

const assert = (label: string, condition: boolean, detail?: string): void =>
  condition ? pass(label) : fail(label, detail);

const readNewestRunFile = (harness: ImplementHarness): { run: { planProblems?: unknown[] } } | undefined => {
  const dir = path.join(harness.homeDir, '.wf', 'state', 'implement-verification', path.basename(harness.repoDir));
  if (!fs.existsSync(dir)) return undefined;
  const [newest] = fs.readdirSync(dir)
    .filter(name => name.endsWith('.json'))
    .map(name => ({ filePath: path.join(dir, name), mtime: fs.statSync(path.join(dir, name)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  return newest ? JSON.parse(fs.readFileSync(newest.filePath, 'utf-8')) : undefined;
};

const findFixRoundPrompt = (harness: ImplementHarness): string =>
  fs.readdirSync(harness.promptDir)
    .map(name => fs.readFileSync(path.join(harness.promptDir, name), 'utf-8'))
    .find(prompt => prompt.includes('Verification round 1')) ?? '';

const runScenario = (mode: FakeClaudeMode) => {
  const harness = setupImplementHarness(`wf-plan-problem-${mode}-`, mode, ['src/a.ts'], {
    stepVerification: { mode: 'pull', provider: 'anthropic', model: 'claude-sonnet-4-6', backend: 'cli' },
    estimatedComplexity: 'medium',
  });
  fs.writeFileSync(harness.planPath, JSON.stringify(planFixture), 'utf-8');
  const result = runImplement(harness);
  return { harness, ...result, runFile: readNewestRunFile(harness), fixPrompt: findFixRoundPrompt(harness) };
};

const stepSection = (prompt: string, stepHeader: string): string => {
  const start = prompt.indexOf(stepHeader);
  if (start === -1) return '';
  const missingLine = prompt.indexOf('\nMissing:', start);
  return prompt.slice(start, missingLine === -1 ? undefined : missingLine);
};

type ScenarioRun = ReturnType<typeof runScenario>;

const assertReportedOutput = ({ exitCode, output, runFile }: ScenarioRun): void => {
  assert('compiled issue:implement exits successfully', exitCode === 0, output.slice(-800));
  assert('terminal notice names the step', output.includes('Plan problem reported for step 1'), output.slice(-800));
  assert('terminal notice carries the reason', output.includes(REASON));
  assert(
    'run file carries the reported plan problem',
    JSON.stringify(runFile?.run.planProblems) === JSON.stringify([{ step: 1, reason: REASON, instead: INSTEAD }]),
    JSON.stringify(runFile?.run),
  );
};

const assertFixRoundPrompt = ({ fixPrompt }: ScenarioRun): void => {
  assert('fix-round prompt exists', fixPrompt.length > 0);
  assert(
    'reported step carries the plan-problem annotation',
    stepSection(fixPrompt, 'Step 0 (').includes(REPORT_MARKER),
    fixPrompt.slice(0, 1200),
  );
  assert('unreported step carries no annotation', !stepSection(fixPrompt, 'Step 1 (').includes(REPORT_MARKER));
  assert('fix-round prompt shows the plan step number', fixPrompt.includes('Step 0 (not-done) - plan step 1'));
};

const verifyReportedScenario = (): void => {
  const run = runScenario('planProblem');
  try {
    assertReportedOutput(run);
    assertFixRoundPrompt(run);
  } finally {
    cleanupHarness(run.harness);
  }
};

const verifyMalformedScenario = (): void => {
  const { harness, output, runFile } = runScenario('planProblemMalformed');
  try {
    assert('malformed line prints no notice', !output.includes('Plan problem reported'), output.slice(-800));
    assert(
      'malformed line leaves run.planProblems absent',
      runFile !== undefined && runFile.run.planProblems === undefined,
    );
  } finally {
    cleanupHarness(harness);
  }
};

const failMissingDist = (): never => {
  fail('dist/main.js must exist', 'Run `yarn build` first.');
  return process.exit(1);
};

const main = (): void => {
  console.log(chalk.bold.cyan('\n  Implement PLAN-PROBLEM report — live smoke test\n'));
  if (!fs.existsSync(distMainPath)) failMissingDist();
  verifyReportedScenario();
  verifyMalformedScenario();
  summarise(counts);
};

main();
