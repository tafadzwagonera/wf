/**
 * Manual smoke test: resuming a recorded session under a changed stage model warns and still resumes,
 * and the model is never persisted
 *
 * Run: nr test:manual session-resume-model-drift-warning.smoke
 *
 * Verifies:
 *   1. Prior-stage resume prints the cross-stage model warning and still passes --resume
 *   2. Interrupted-stage resume prints the same-stage drift warning and still passes --resume
 *   3. A model-only change is not reported as config drift
 *   4. An unchanged model prints no model warning
 *   5. The persisted review stage config has no model key
 */
import assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { createReporter, summarise } from './support/reporter';
import { buildSessionFileName } from '../../src/shared/utils/session-file-name';
import {
  buildPlanArtifactFilename,
  buildPlanArtifactManifest,
  hashPlanArtifactSources,
  writePlanArtifactManifest,
} from '../../src/shared/utils/plan-artifact';

const distMainPath = path.join(__dirname, '../../dist/main.js');
const { counts, pass, fail } = createReporter();
const seededCreatedAt = new Date().toISOString();
const recordedModel = 'claude-old';
const changedModel = 'claude-new';

type StageSeed = { completed: boolean; providerSessionId: string };
type ScenarioInput = { name: string; configuredModel: string; seededStages: Record<string, StageSeed> };
type ScenarioPaths = { homeDir: string; repoDir: string; binDir: string; statePath: string; invocationPath: string };

const createScenarioPaths = (tempRoot: string): ScenarioPaths => ({
  homeDir: path.join(tempRoot, 'home'),
  repoDir: path.join(tempRoot, 'repo'),
  binDir: path.join(tempRoot, 'bin'),
  statePath: path.join(
    tempRoot, 'home/.wf/state/sessions',
    buildSessionFileName({ ticketKey: 'DRIFT-1', sessionId: 'wf-session', createdAt: seededCreatedAt })
  ),
  invocationPath: path.join(tempRoot, 'invocations.log'),
});

const setupGitRepository = (repoDir: string): void => {
  const gitEnv = {
    ...process.env,
    GIT_AUTHOR_NAME: 'wf', GIT_AUTHOR_EMAIL: 'wf@example.com',
    GIT_COMMITTER_NAME: 'wf', GIT_COMMITTER_EMAIL: 'wf@example.com',
  };
  const sourcePath = path.join(repoDir, 'source.ts');
  execFileSync('git', ['init', '-q'], { cwd: repoDir, env: gitEnv });
  fs.writeFileSync(sourcePath, 'export const review = 1;\n');
  execFileSync('git', ['add', 'source.ts'], { cwd: repoDir, env: gitEnv });
  execFileSync('git', ['commit', '-q', '-m', 'initial'], { cwd: repoDir, env: gitEnv });
  fs.writeFileSync(sourcePath, 'export const review = 2;\n');
};

const setupTicketArtifacts = (paths: ScenarioPaths): void => {
  const artifactDir = path.join(paths.homeDir, '.wf', path.basename(paths.repoDir), 'jira');
  fs.mkdirSync(artifactDir, { recursive: true });
  fs.writeFileSync(path.join(artifactDir, 'DRIFT-1.md'), '# DRIFT-1\n\nModel drift on resume.\n');
  const planHash = hashPlanArtifactSources(['DRIFT-1']);
  const planPath = path.join(artifactDir, buildPlanArtifactFilename({ hash: planHash, action: 'fix', format: 'json' }));
  fs.writeFileSync(planPath, JSON.stringify({
    action: 'fix', summary: 'Drift', estimatedComplexity: 'low', steps: [], affectedFiles: [], affectedRepositories: [],
  }));
  writePlanArtifactManifest(buildPlanArtifactManifest({
    artifactPath: planPath, action: 'fix', format: 'json', hash: planHash,
    sourceName: 'DRIFT-1', sourceKind: 'ticket', createdAt: new Date(),
  }));
};

const buildStageRecord = (seed: StageSeed) => ({
  config: { provider: 'anthropic', backend: 'cli' },
  model: recordedModel,
  modelsUsed: [],
  providerSessionId: seed.providerSessionId,
  summary: null,
  startedAt: new Date().toISOString(),
  completedAt: seed.completed ? new Date().toISOString() : null,
});

const setupSession = (paths: ScenarioPaths, input: ScenarioInput): void => {
  fs.mkdirSync(path.dirname(paths.statePath), { recursive: true });
  const config = `module.exports={ai:[{provider:'anthropic',model:'claude-sonnet-4-6',default:true,apiKey:'k'}],`
    + `stages:{implement:{provider:'anthropic',backend:'cli'},`
    + `review:{provider:'anthropic',backend:'cli',model:'${input.configuredModel}'}}};\n`;
  fs.writeFileSync(path.join(paths.repoDir, 'wf.config.js'), config);
  const stages = Object.fromEntries(
    Object.entries(input.seededStages).map(([stage, seed]) => [stage, buildStageRecord(seed)])
  );
  fs.writeFileSync(paths.statePath, JSON.stringify({
    sessionId: 'wf-session', ticketKey: 'DRIFT-1', toStage: 'review', action: 'fix', sourceType: 'ticket',
    customPlanRef: null, sourceBranch: 'main', createdAt: seededCreatedAt, updatedAt: new Date().toISOString(),
    completedAt: null, stages,
  }));
};

const setupFakeClaude = (paths: ScenarioPaths): void => {
  const reviewResult = JSON.stringify({
    summary: 'ok', issues: [], executionMode: 'cli', repairStrategy: null, traceProvenance: 'best-effort',
    callStack: null, stateTransition: null, suggestions: [], approved: true,
  });
  const script = `#!/usr/bin/env node\nconst fs=require('fs'),a=process.argv.slice(2);`
    + `fs.appendFileSync(${JSON.stringify(paths.invocationPath)},JSON.stringify(a)+'\\n');`
    + `console.log(JSON.stringify({type:'result',subtype:'success',structured_output:${reviewResult},session_id:'resumed-session'}));`;
  const executable = path.join(paths.binDir, 'claude');
  fs.mkdirSync(paths.binDir, { recursive: true });
  fs.writeFileSync(executable, script);
  fs.chmodSync(executable, 0o755);
};

const readStageInvocations = (invocationPath: string): string[][] => {
  const lines = fs.existsSync(invocationPath) ? fs.readFileSync(invocationPath, 'utf8').trim().split('\n') : [];
  return lines.map(line => JSON.parse(line) as string[]).filter(args => args.includes('--json-schema'));
};

type RunResult = { status: number | null; output: string; invocations: string[][]; persistedState: string };

const seedScenario = (paths: ScenarioPaths, input: ScenarioInput): void => {
  fs.mkdirSync(paths.repoDir, { recursive: true });
  setupGitRepository(paths.repoDir);
  setupTicketArtifacts(paths);
  setupSession(paths, input);
  setupFakeClaude(paths);
};

const spawnIssueReview = (paths: ScenarioPaths): { status: number | null; output: string } => {
  const result = spawnSync(process.execPath, [
    distMainPath, 'issue', '--session-id', 'wf-session',
    '--ticket-key', 'DRIFT-1', '--from', 'review', '--to', 'review', '--silent',
  ], {
    cwd: paths.repoDir,
    encoding: 'utf8',
    env: {
      ...process.env, HOME: paths.homeDir, WF_SKIP_CLI_VERSION_CHECK: '1',
      PATH: `${paths.binDir}${path.delimiter}${process.env.PATH ?? ''}`,
    },
  });
  return { status: result.status, output: `${result.stdout ?? ''}${result.stderr ?? ''}` };
};

const runScenario = (input: ScenarioInput): RunResult => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-model-drift-'));
  try {
    const paths = createScenarioPaths(tempRoot);
    seedScenario(paths, input);
    return {
      ...spawnIssueReview(paths),
      invocations: readStageInvocations(paths.invocationPath),
      persistedState: fs.readFileSync(paths.statePath, 'utf8'),
    };
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
};

const check = (label: string, assertions: () => void): void => {
  try {
    assertions();
    pass(label);
  } catch (error) {
    fail(label, String(error));
  }
};

const assertResumedWith = (result: RunResult, sessionId: string): void => {
  assert.strictEqual(result.status, 0, result.output);
  assert.ok(
    result.invocations.some(args => args.includes('--resume') && args.includes(sessionId)),
    JSON.stringify(result.invocations)
  );
};

const assertNoConfigDrift = (output: string): void => {
  assert.strictEqual(output.includes('Config drift detected'), false, output);
  assert.strictEqual(output.includes('cannot be resumed'), false, output);
};

const portableText = 'provider sessions are portable across models';

const priorStageScenario: ScenarioInput = {
  name: 'prior stage',
  configuredModel: changedModel,
  seededStages: { implement: { completed: true, providerSessionId: 'impl-session' } },
};
const interruptedStageScenario: ScenarioInput = {
  name: 'interrupted stage',
  configuredModel: changedModel,
  seededStages: { review: { completed: false, providerSessionId: 'review-session' } },
};
const unchangedModelScenario: ScenarioInput = {
  name: 'unchanged model',
  configuredModel: recordedModel,
  seededStages: { review: { completed: false, providerSessionId: 'review-session' } },
};

const checkPriorStage = (prior: RunResult): void => check(
  'Prior-stage model change warns and still resumes the implement session',
  () => {
    const expected = `Model for review (${changedModel}) differs from implement's recorded ${recordedModel}`;
    assert.ok(prior.output.includes(expected), prior.output);
    assert.ok(prior.output.includes(portableText), prior.output);
    assertResumedWith(prior, 'impl-session');
    assertNoConfigDrift(prior.output);
  }
);

const checkInterruptedStage = (interrupted: RunResult): void => check(
  'Interrupted-stage model change warns as drift and still resumes the review session',
  () => {
    const expected = `Stage review session was recorded with model ${recordedModel} `
      + `but wf.config now resolves to ${changedModel}`;
    assert.ok(interrupted.output.includes(expected), interrupted.output);
    assertResumedWith(interrupted, 'review-session');
    assertNoConfigDrift(interrupted.output);
  }
);

const checkUnchangedModel = (unchanged: RunResult): void => check('Unchanged model prints no model warning', () => {
  assert.strictEqual(unchanged.output.includes(portableText), false, unchanged.output);
  assertResumedWith(unchanged, 'review-session');
});

const checkPersistedConfig = (interrupted: RunResult): void => check(
  'Persisted review stage config contains no model key',
  () => {
    const persisted = JSON.parse(interrupted.persistedState);
    assert.deepStrictEqual(persisted.stages.review.config, { provider: 'anthropic', backend: 'cli' });
  }
);

const main = (): void => {
  if (!fs.existsSync(distMainPath)) throw new Error('dist/main.js must exist. Run `yarn build` first.');
  const interrupted = runScenario(interruptedStageScenario);
  checkPriorStage(runScenario(priorStageScenario));
  checkInterruptedStage(interrupted);
  checkUnchangedModel(runScenario(unchangedModelScenario));
  checkPersistedConfig(interrupted);
  summarise(counts);
};

try {
  main();
} catch (error) {
  console.error(error);
  process.exit(1);
}
