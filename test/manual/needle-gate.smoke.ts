/**
 * Manual smoke test: issue:plan flags a removal step that lacks a case-insensitive zero-match verification
 *
 * Run (after `yarn build`): nr test:manual needle-gate.smoke
 *
 * Scenario: `node dist/main.js issue:plan --action fix --custom-plan source.md --silent` with a fake `claude` that
 * returns a plan whose single step removes NUXT_POWERREVIEWS_API_KEY. The plan stage validates the draft, retries
 * once with the violation in the repair prompt, and prints the violations that persist.
 *
 * Config under test:
 *   stages: { plan: { provider: 'anthropic', backend: 'cli' } }
 *
 * Verify:
 *   1. Plan without verification: output reports `[needle-search-required]` and the repair prompt carries it.
 *   2. Plan with a case-insensitive `bash -c '! git grep ...'` command: no `[needle-search-required]` and no
 *      `[verification-allowlist]`.
 *   3. Plan whose command lacks `-i`: output reports `[needle-search-required]`.
 *   4. Plan with a `needle-search-required` waiver: no `[needle-search-required]`.
 *   5. In every variant the command still exits 0 (the rule is advisory) and writes a plan artifact.
 *
 * Wire up: support/plan-cli-harness.ts (temp repo, fake `claude` on PATH, isolated HOME); requires `yarn build`.
 * Teardown: the temp root (repo, bin, home, prompts) is removed.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import chalk from 'chalk';
import {
  cleanupPlanHarness, countPlanSpawns, distMainPath, readPlanPrompt, runPlan, setupPlanHarness,
  type PlanHarness, type PlanRunResult,
} from './support/plan-cli-harness';
import { createReporter, summarise } from './support/reporter';

const { counts, pass, fail } = createReporter();

const assert = (label: string, condition: boolean, detail?: string): void =>
  condition ? pass(label) : fail(label, detail);

const term = 'NUXT_POWERREVIEWS_API_KEY';
const NEEDLE_TAG = '[needle-search-required]';
const ALLOWLIST_TAG = '[verification-allowlist]';
const removalStep = `Remove ${term} from repo/src/env.ts.`;

const buildPlan = (verification?: Record<string, unknown>): Record<string, unknown> => ({
  action: 'fix',
  summary: 'Remove the PowerReviews API key',
  steps: [removalStep],
  estimatedComplexity: 'low',
  affectedFiles: [{ filePath: 'repo/src/env.ts', status: 'found' }],
  affectedRepositories: ['repo'],
  risks: [],
  ...(verification ? { verification } : {}),
});

const targeted = (id: string, run: string): Record<string, unknown> => ({
  targeted: [{ id, run, policy: 'enforced', reason: 'zero matches remain' }],
});

const planFiles = { 'src/env.ts': `export const key = '${term}';\n`, '.env.example': `${term}=changeme\n` };

const withHarness = <T>(plan: Record<string, unknown>, fn: (harness: PlanHarness, result: PlanRunResult) => T): T => {
  const harness = setupPlanHarness('wf-needle-gate-', plan, planFiles);
  try {
    return fn(harness, runPlan(harness));
  } finally {
    cleanupPlanHarness(harness);
  }
};

const artifactWritten = (harness: PlanHarness): boolean =>
  fs.existsSync(path.join(harness.homeDir, '.wf', 'repo')) && fs.readdirSync(path.join(harness.homeDir, '.wf', 'repo')).length > 0;

function verifyUnguardedPlanIsFlagged(): void {
  withHarness(buildPlan(), (harness, { exitCode, output }) => {
    assert('plan without verification is flagged', output.includes(NEEDLE_TAG), output.slice(-800));
    assert('violation is reported after the repair retry', output.includes('Plan quality violations persisted after retry'));
    assert('repair prompt carries the needle rule', readPlanPrompt(harness, 2).includes('needle-search-required'));
    assert('rule is advisory: exit 0', exitCode === 0, output.slice(-400));
    assert('rule is advisory: plan artifact written', artifactWritten(harness));
  });
}

function verifyCaseInsensitiveCommandPasses(): void {
  const command = `bash -c '! git grep -I -i -q -F ${term.toLowerCase()}'`;
  withHarness(buildPlan(targeted('needle', command)), (harness, { output }) => {
    assert('case-insensitive bash -c command satisfies the rule', !output.includes(NEEDLE_TAG), output.slice(-800));
    assert('case-insensitive bash -c command passes the allowlist', !output.includes(ALLOWLIST_TAG));
    assert('no repair retry was needed', countPlanSpawns(harness) === 1, `spawns=${countPlanSpawns(harness)}`);
  });
}

function verifyMissingIgnoreCaseIsFlagged(): void {
  withHarness(buildPlan(targeted('needle-no-i', `bash -c '! git grep -I -q -F ${term}'`)), (_harness, { output }) => {
    assert('command without -i is flagged', output.includes(NEEDLE_TAG), output.slice(-800));
  });
}

function verifyWaiverSuppresses(): void {
  const waivers = { waivers: [{ id: 'needle-search-required', reason: 'ADR keeps the old name' }] };
  withHarness(buildPlan(waivers), (_harness, { output }) => {
    assert('waiver suppresses the rule', !output.includes(NEEDLE_TAG), output.slice(-800));
  });
}

const verifyNeedleGate = (): void => {
  verifyUnguardedPlanIsFlagged();
  verifyCaseInsensitiveCommandPasses();
  verifyMissingIgnoreCaseIsFlagged();
  verifyWaiverSuppresses();
  summarise(counts);
};

const failMissingDist = (): never => {
  fail('dist/main.js must exist', 'Run `yarn build` first.');
  return process.exit(1);
};

function main(): void {
  console.log(chalk.bold.cyan('\n  Needle-search-required plan gate — live smoke test\n'));
  const run = fs.existsSync(distMainPath) ? verifyNeedleGate : failMissingDist;
  run();
}

main();
