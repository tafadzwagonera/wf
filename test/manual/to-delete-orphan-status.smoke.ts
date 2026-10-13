/**
 * Manual smoke test: a `to-delete` plan entry is validated by issue:plan and a file the agent deletes counts as
 * done in issue:implement
 *
 * Run (after `yarn build`): nr test:manual to-delete-orphan-status.smoke
 *
 * Scenario: (1) `node dist/main.js issue:plan --action fix --custom-plan source.md --silent` with a fake `claude`
 * returning a plan that lists `repo/src/orphan.ts` as `to-delete` in `affectedFilesContext`. (2) The same command with
 * the entry in `affectedFiles`. (3) `node dist/main.js issue:implement <plan> --silent --no-branch --skip-install`
 * with a `to-delete` entry for `src/orphan.ts`, once with a fake claude that deletes the file and once with a no-op
 * fake claude as the control.
 *
 * Config under test:
 *   stages: { plan: { provider: 'anthropic', backend: 'cli' }, implement: { provider: 'anthropic', backend: 'cli' } }
 *
 * Verify:
 *   1. Plan with `to-delete` in affectedFilesContext exits non-zero and names the rejected status and path.
 *   2. Plan with `to-delete` in affectedFiles exits 0 and the status survives into the saved artifact.
 *   3. Implement with the deleting fake claude: the file is gone and claude is spawned exactly once.
 *   4. Implement with the no-op fake claude (control): the file remains and claude is spawned more than once.
 *
 * Wire up: support/plan-cli-harness.ts for the plan runs and support/implement-cli-harness.ts (deleteOrphan mode)
 * for the implement runs; requires `yarn build`.
 * Teardown: each harness temp root is removed.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import chalk from 'chalk';
import {
  cleanupPlanHarness, runPlan, setupPlanHarness, type PlanHarness,
} from './support/plan-cli-harness';
import {
  cleanupHarness, countSpawns, distMainPath, runImplement, setupImplementHarness, type FakeClaudeMode,
} from './support/implement-cli-harness';
import { createReporter, summarise } from './support/reporter';

const { counts, pass, fail } = createReporter();

const assert = (label: string, condition: boolean, detail?: string): void =>
  condition ? pass(label) : fail(label, detail);

const orphanEntry = { filePath: 'repo/src/orphan.ts', status: 'to-delete' };
const keeperEntry = { filePath: 'repo/src/keeper.ts', status: 'found' };
const orphanFiles = { 'src/orphan.ts': 'export {};\n', 'src/keeper.ts': 'export {};\n' };

const buildPlan = (extra: Record<string, unknown>): Record<string, unknown> => ({
  action: 'fix',
  summary: 'Delete the orphaned module',
  steps: ['Edit repo/src/keeper.ts.'],
  estimatedComplexity: 'low',
  affectedRepositories: ['repo'],
  risks: [],
  ...extra,
});

const savedArtifactText = (harness: PlanHarness): string => {
  const dir = path.join(harness.homeDir, '.wf', 'repo');
  const names = fs.existsSync(dir) ? fs.readdirSync(dir).filter(name => name.endsWith('.json')) : [];
  return names.map(name => fs.readFileSync(path.join(dir, name), 'utf-8')).join('\n');
};

function verifyContextRejected(): void {
  const plan = buildPlan({ affectedFiles: [keeperEntry], affectedFilesContext: [orphanEntry] });
  const harness = setupPlanHarness('wf-to-delete-context-', plan, orphanFiles);
  try {
    const { exitCode, output } = runPlan(harness);
    assert('context to-delete exits non-zero', exitCode !== 0, `exit=${exitCode}`);
    assert('error names the rejected status', output.includes('cannot have status "to-create" or "to-delete"'), output.slice(-600));
    assert('error names the offending path', output.includes('src/orphan.ts'));
  } finally {
    cleanupPlanHarness(harness);
  }
}

function verifyAffectedAccepted(): void {
  const plan = buildPlan({ affectedFiles: [keeperEntry, orphanEntry] });
  const harness = setupPlanHarness('wf-to-delete-affected-', plan, orphanFiles);
  try {
    const { exitCode, output } = runPlan(harness);
    assert('affectedFiles to-delete exits 0', exitCode === 0, output.slice(-600));
    assert('to-delete survives into the artifact', savedArtifactText(harness).includes('"to-delete"'));
  } finally {
    cleanupPlanHarness(harness);
  }
}

const runImplementScenario = (mode: FakeClaudeMode): { spawns: number; orphanExists: boolean } => {
  const harness = setupImplementHarness('wf-to-delete-impl-', mode, ['src/orphan.ts'], {
    statusByFile: { 'src/orphan.ts': 'to-delete' },
  });
  try {
    runImplement(harness);
    return { spawns: countSpawns(harness), orphanExists: fs.existsSync(path.join(harness.repoDir, 'src/orphan.ts')) };
  } finally {
    cleanupHarness(harness);
  }
};

function verifyImplementCountsDeletionAsDone(): void {
  const deleted = runImplementScenario('deleteOrphan');
  assert('deleting claude removes the file', !deleted.orphanExists);
  assert('deleted file needs no continuation pass', deleted.spawns === 1, `spawns=${deleted.spawns}`);
  const control = runImplementScenario('noop');
  assert('control keeps the file', control.orphanExists);
  assert('control needs continuation passes', control.spawns > 1, `spawns=${control.spawns}`);
}

const verifyToDeleteStatus = (): void => {
  verifyContextRejected();
  verifyAffectedAccepted();
  verifyImplementCountsDeletionAsDone();
  summarise(counts);
};

const failMissingDist = (): never => {
  fail('dist/main.js must exist', 'Run `yarn build` first.');
  return process.exit(1);
};

function main(): void {
  console.log(chalk.bold.cyan('\n  to-delete orphan status — live smoke test\n'));
  const run = fs.existsSync(distMainPath) ? verifyToDeleteStatus : failMissingDist;
  run();
}

main();
