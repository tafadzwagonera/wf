/**
 * Manual smoke test: issue:plan records a non-blocking `duplicate-resolver` plan risk when the plan re-reads config
 * keys that an existing resolver in the repo already reads
 *
 * Run (after `yarn build`): nr test:manual plan-quality-duplicate-resolver.smoke
 *
 * Scenario: `node dist/main.js issue:plan --action fix --custom-plan source.md --silent` in a temp git repo holding a
 * resolver that reads `stages.${stage}.provider` and `ai.stages.${stage}.provider`, with a fake `claude` that returns
 * a plan naming two such keys and adding `resolvePullAssessorSupport`.
 *
 * Verify:
 *   1. The command exits 0 and writes a plan artifact.
 *   2. The saved plan risks include `reuse ... in <file>:<line>, or state why it cannot be reused`.
 *   3. The planner is spawned once: the advisory rule does not trigger a repair retry.
 *
 * Wire up: support/plan-cli-harness.ts (temp repo, fake `claude` on PATH, isolated HOME); needs `yarn build`, git.
 * Teardown: the temp root (repo, bin, home, prompts) is removed.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import chalk from 'chalk';
import {
  cleanupPlanHarness, countPlanSpawns, distMainPath, runPlan, setupPlanHarness, type PlanHarness,
} from './support/plan-cli-harness';
import { createReporter, summarise } from './support/reporter';

const { counts, pass, fail } = createReporter();

const assert = (label: string, condition: boolean, detail?: string): void =>
  condition ? pass(label) : fail(label, detail);

const REUSE_PATTERN = /reuse .* in .*:\d+, or state why it cannot be reused/;

const resolverSource = [
  'export class StageResolver {',
  '  resolveStageProvider(stage: string): string | undefined {',
  '    const primary = this.config.get<string>(`stages.${stage}.provider`);',
  '    return primary ?? this.config.get<string>(`ai.stages.${stage}.provider`);',
  '  }',
  '}',
  '',
].join('\n');

const plan = {
  action: 'fix',
  summary: 'Resolve the pull assessor provider',
  steps: [
    'Add `resolvePullAssessorSupport` in repo/src/support.ts reading `stages.implement.provider` and '
    + '`ai.stages.plan.provider`.',
  ],
  estimatedComplexity: 'low',
  affectedFiles: [{ filePath: 'repo/src/support.ts', status: 'found' }],
  affectedRepositories: ['repo'],
  risks: [],
};

const commitRepo = (repoDir: string): void => {
  const git = (...args: string[]): void => {
    execFileSync('git', args, { cwd: repoDir, stdio: 'ignore' });
  };
  git('init', '-q');
  git('config', 'user.email', 'smoke@example.com');
  git('config', 'user.name', 'Smoke');
  git('add', '-A');
  git('commit', '-q', '-m', 'fixture');
};

const readArtifactRisks = (harness: PlanHarness): string[] => {
  const dir = path.join(harness.homeDir, '.wf', 'repo');
  const artifacts = fs.existsSync(dir) ? fs.readdirSync(dir).filter(name => name.endsWith('-plan.json')) : [];
  return artifacts.flatMap(name => {
    const saved = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf-8')) as { risks?: { description: string }[] };
    return (saved.risks ?? []).map(risk => risk.description);
  });
};

const runFixture = (harness: PlanHarness): void => {
  commitRepo(harness.repoDir);
  const { exitCode, output } = runPlan(harness);
  const risks = readArtifactRisks(harness);
  assert('command exits 0', exitCode === 0, output.slice(-600));
  assert('saved plan risks include the reuse text', risks.some(risk => REUSE_PATTERN.test(risk)), risks.join('\n'));
  assert('planner spawned once', countPlanSpawns(harness) === 1, `spawns=${countPlanSpawns(harness)}`);
};

const verifyDuplicateResolverRisk = (): void => {
  const files = { 'src/support.ts': 'export {};\n', 'src/resolver.ts': resolverSource };
  const harness = setupPlanHarness('wf-duplicate-resolver-', plan, files);
  try {
    runFixture(harness);
  } finally {
    cleanupPlanHarness(harness);
  }
  summarise(counts);
};

const failMissingDist = (): never => {
  fail('dist/main.js must exist', 'Run `yarn build` first.');
  return process.exit(1);
};

function main(): void {
  console.log(chalk.bold.cyan('\n  Duplicate-resolver plan rule — live smoke test\n'));
  const run = fs.existsSync(distMainPath) ? verifyDuplicateResolverRisk : failMissingDist;
  run();
}

main();
