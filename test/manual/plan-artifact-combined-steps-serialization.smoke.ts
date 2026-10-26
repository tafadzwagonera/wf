/**
 * Manual smoke test: issue:plan persists artifacts in the combined step shape — a model
 * response with legacy flat string steps is coerced into intent-less step objects in the
 * saved JSON, and a combined response's intent is rendered as an Intent: line indented
 * under its numbered step in the saved markdown.
 *
 * Run (after `yarn build`): nr test:manual plan-artifact-combined-steps-serialization.smoke
 *
 * Verifies:
 *   1. issue:plan --format json exits 0 on a flat-steps model response
 *   2. the saved .json artifact carries intent-less combined step objects and no stepIntents key
 *   3. issue:plan --format md exits 0 on a combined model response carrying an intent
 *   4. the .md artifact has the Intent: line under step 1 only
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import chalk from 'chalk';
import {
  cleanupPlanHarness, distMainPath, runPlanCli, setupPlanHarness, type PlanHarness,
} from './support/plan-cli-harness';
import { createReporter, summarise } from './support/reporter';

const { counts, pass, fail } = createReporter();

const STEP_ONE = 'Rename AuthGuard to SharedAuthGuard in repo/src/auth/guard.ts';
const STEP_TWO = 'Update imports in repo/src/controllers/index.ts';
const INTENT_TEXT = 'guard.ts declares SharedAuthGuard and no longer declares AuthGuard';

const basePlanResponse = {
  action: 'fix',
  summary: 'Rename guard',
  affectedFiles: [
    { filePath: 'repo/src/auth/guard.ts', status: 'found' },
    { filePath: 'repo/src/controllers/index.ts', status: 'found' },
  ],
  affectedRepositories: ['repo'],
  risks: [],
};

const flatLegacyModelResponse = { ...basePlanResponse, steps: [STEP_ONE, STEP_TWO] };

const combinedModelResponse = {
  ...basePlanResponse,
  steps: [{ description: STEP_ONE, intent: INTENT_TEXT }, { description: STEP_TWO }],
};

const repoFiles = {
  'src/auth/guard.ts': 'export {};\n',
  'src/controllers/index.ts': 'export {};\n',
};

const assert = (label: string, condition: boolean, detail?: string): void =>
  condition ? pass(label) : fail(label, detail);

const findArtifact = (harness: PlanHarness, extension: string): string | undefined => {
  const dir = path.join(harness.homeDir, '.wf', 'repo');
  if (!fs.existsSync(dir)) return undefined;
  const name = fs.readdirSync(dir).find(file => file.endsWith(`-fix-plan.${extension}`));
  return name && path.join(dir, name);
};

const withFormat = (
  format: string, modelResponse: Record<string, unknown>,
  verify: (exitCode: number | null, output: string, artifact?: string) => void,
): void => {
  const harness = setupPlanHarness('wf-combined-steps-', modelResponse, repoFiles);
  try {
    const { exitCode, output } = runPlanCli(harness, [
      '--action', 'fix', '--custom-plan', path.join(harness.repoDir, 'source.md'), '--silent', '--format', format,
    ]);
    verify(exitCode, output, findArtifact(harness, format));
  } finally {
    cleanupPlanHarness(harness);
  }
};

const assertCombinedJsonSteps = (raw: string): void => {
  const plan = JSON.parse(raw);
  assert(
    'json steps are intent-less combined objects coerced from flat strings',
    plan.steps?.[0]?.description === STEP_ONE && plan.steps?.[1]?.description === STEP_TWO,
    JSON.stringify(plan.steps),
  );
  assert(
    'json steps carry no intent keys',
    !('intent' in (plan.steps?.[0] ?? {})) && !('intent' in (plan.steps?.[1] ?? {})),
    JSON.stringify(plan.steps),
  );
  assert('json artifact contains no stepIntents key', !raw.includes('stepIntents'));
};

const assertMarkdownIntentLines = (md: string): void => {
  assert(
    'md renders the Intent: line indented under step 1',
    md.includes(`1. ${STEP_ONE}\n   Intent: ${INTENT_TEXT}`),
    md.slice(0, 500),
  );
  assert(
    'md renders step 2 without an Intent: line',
    md.includes(`2. ${STEP_TWO}\n`) && !md.includes(`2. ${STEP_TWO}\n   Intent:`),
  );
};

const verifyJsonArtifact = (): void => {
  withFormat('json', flatLegacyModelResponse, (exitCode, output, artifact) => {
    assert('issue:plan --format json exits 0 on a flat-steps model response', exitCode === 0, output.slice(-800));
    if (!artifact) return fail('json artifact was written', 'no *-fix-plan.json under the fake wf home');
    assertCombinedJsonSteps(fs.readFileSync(artifact, 'utf-8'));
  });
};

const verifyMarkdownArtifact = (): void => {
  withFormat('md', combinedModelResponse, (exitCode, output, artifact) => {
    assert('issue:plan --format md exits 0 on a combined model response', exitCode === 0, output.slice(-800));
    if (!artifact) return fail('md artifact was written', 'no *-fix-plan.md under the fake wf home');
    assertMarkdownIntentLines(fs.readFileSync(artifact, 'utf-8'));
  });
};

const failMissingDist = (): never => {
  fail('dist/main.js must exist', 'Run `yarn build` first.');
  return process.exit(1);
};

const main = (): void => {
  console.log(chalk.bold.cyan('\n  combined-steps plan serialization smoke test\n'));
  if (!fs.existsSync(distMainPath)) failMissingDist();
  verifyJsonArtifact();
  verifyMarkdownArtifact();
  summarise(counts);
};

main();
