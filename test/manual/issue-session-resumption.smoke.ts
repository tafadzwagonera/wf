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

async function main(): Promise<void> {
  assertCompiledArtifacts();
  runCompiledIssueFallbackScenario();
  runPriorCompatibleSessionScenario();
  runInterruptedReviewEarlyRecordScenario();
  summarise(counts);
}

const assertCompiledArtifacts = (): void => {
  if (fs.existsSync(distMainPath)) return;
  throw new Error('dist/main.js must exist. Run `yarn build` first.');
};

const spawnWfIssueReview = (paths: ScenarioPaths): { status: number | null; output: string } => {
  const result = spawnSync(process.execPath, [
    distMainPath, 'issue', '--session-id', 'wf-session',
    '--ticket-key', 'RESUME-1', '--from', 'review', '--to', 'review', '--silent',
  ], { cwd: paths.repoDir, encoding: 'utf8', env: scenarioEnv(paths) });
  return { status: result.status, output: `${result.stdout ?? ''}${result.stderr ?? ''}` };
};

const runCompiledIssueFallbackScenario = (): void => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-session-resume-'));
  try {
    const paths = createScenarioPaths(tempRoot);
    setupScenario(paths);
    const { status, output } = spawnWfIssueReview(paths);
    assertScenarioResult(status, output, paths);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
};

const runPriorCompatibleSessionScenario = (): void => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-session-compatible-'));
  try {
    const paths = createScenarioPaths(tempRoot);
    setupScenario(paths);
    setupPriorCompatibleSession(paths);
    const { status, output } = spawnWfIssueReview(paths);
    assertPriorCompatibleSessionResult(status, output, paths);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
};

const runInterruptedThenResumedReview = (paths: ScenarioPaths): void => {
  const interrupted = spawnWfIssueReview(paths);
  assertInterruptedReviewPersistsEarlySessionId(interrupted.status, interrupted.output, paths);
  fs.writeFileSync(paths.resumeReadyPath, '');
  const resumed = spawnWfIssueReview(paths);
  assertResumedReviewUsesEarlySessionId(resumed.status, resumed.output, paths);
};

const runInterruptedReviewEarlyRecordScenario = (): void => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-session-early-record-'));
  try {
    const paths = createScenarioPaths(tempRoot);
    setupScenario(paths);
    setupFreshReviewSessionState(paths);
    writeEarlyRecordClaude(paths);
    runInterruptedThenResumedReview(paths);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
};

const seededCreatedAt = new Date().toISOString();

type ScenarioPaths = {
  homeDir: string; repoDir: string; binDir: string; statePath: string;
  invocationPath: string; resumeReadyPath: string;
};

const createScenarioPaths = (tempRoot: string): ScenarioPaths => ({
  homeDir: path.join(tempRoot, 'home'), repoDir: path.join(tempRoot, 'repo'), binDir: path.join(tempRoot, 'bin'),
  statePath: path.join(
    tempRoot, 'home/.wf/state/sessions',
    buildSessionFileName({ ticketKey: 'RESUME-1', sessionId: 'wf-session', createdAt: seededCreatedAt })
  ),
  invocationPath: path.join(tempRoot, 'invocations.log'),
  resumeReadyPath: path.join(tempRoot, 'resume-ready'),
});

const setupScenario = (paths: ScenarioPaths): void => {
  fs.mkdirSync(path.dirname(paths.statePath), { recursive: true });
  fs.mkdirSync(paths.repoDir, { recursive: true });
  fs.mkdirSync(paths.binDir, { recursive: true });
  setupGitRepository(paths.repoDir);
  setupTicketArtifacts(paths);
  setupSessionState(paths);
  setupFakeClaude(paths);
};

const setupTicketArtifacts = (paths: ScenarioPaths): void => {
  const artifactDir = path.join(paths.homeDir, '.wf', path.basename(paths.repoDir), 'jira');
  fs.mkdirSync(artifactDir, { recursive: true });
  fs.writeFileSync(path.join(artifactDir, 'RESUME-1.md'), '# RESUME-1\n\nReview session fallback.\n');
  const planHash = hashPlanArtifactSources(['RESUME-1']);
  const planPath = path.join(artifactDir, buildPlanArtifactFilename({ hash: planHash, action: 'fix', format: 'json' }));
  fs.writeFileSync(planPath, JSON.stringify({
    action: 'fix', summary: 'Review fallback', estimatedComplexity: 'low', steps: [], affectedFiles: [], affectedRepositories: [],
  }));
  writePlanArtifactManifest(buildPlanArtifactManifest({
    artifactPath: planPath, action: 'fix', format: 'json', hash: planHash, sourceName: 'RESUME-1', sourceKind: 'ticket', createdAt: new Date(),
  }));
};

const setupSessionState = (paths: ScenarioPaths): void => {
  fs.writeFileSync(path.join(paths.repoDir, 'wf.config.js'), "module.exports={ai:[{provider:'anthropic',model:'claude-sonnet-4-6',default:true,apiKey:'test-key'}],stages:{review:{provider:'anthropic',backend:'cli'}}};\n");
  fs.writeFileSync(paths.statePath, JSON.stringify({
    sessionId: 'wf-session', ticketKey: 'RESUME-1', toStage: 'review', action: 'fix', sourceType: 'ticket',
    customPlanRef: null, sourceBranch: 'main', createdAt: seededCreatedAt, updatedAt: new Date().toISOString(), completedAt: null,
    stages: { implement: { config: { provider: 'anthropic', backend: 'cli' }, model: 'claude', modelsUsed: [], providerSessionId: 'stale-session', summary: null, startedAt: new Date().toISOString(), completedAt: new Date().toISOString() } },
  }));
};

const setupFreshReviewSessionState = (paths: ScenarioPaths): void => {
  fs.writeFileSync(paths.statePath, JSON.stringify({
    sessionId: 'wf-session', ticketKey: 'RESUME-1', toStage: 'review', action: 'fix', sourceType: 'ticket',
    customPlanRef: null, sourceBranch: 'main', createdAt: seededCreatedAt, updatedAt: new Date().toISOString(), completedAt: null,
    stages: {},
  }));
};

const setupPriorCompatibleSession = (paths: ScenarioPaths): void => {
  fs.writeFileSync(paths.statePath, JSON.stringify({
    sessionId: 'wf-session', ticketKey: 'RESUME-1', toStage: 'review', action: 'fix', sourceType: 'ticket',
    customPlanRef: null, sourceBranch: 'main', createdAt: seededCreatedAt, updatedAt: new Date().toISOString(), completedAt: null,
    stages: {
      plan: createCompletedStage('anthropic', 'cli', 'plan-session'),
      implement: createCompletedStage('openai', 'agent', 'implement-session'),
    },
  }));
  writeCompatibleClaude(paths);
};

const createCompletedStage = (provider: string, backend: string, providerSessionId: string) => ({
  config: { provider, backend }, model: 'test-model', modelsUsed: [], providerSessionId,
  summary: null, startedAt: new Date().toISOString(), completedAt: new Date().toISOString(),
});

const fakeReviewResultJson = JSON.stringify({
  summary: 'ok', issues: [], executionMode: 'cli', repairStrategy: null, traceProvenance: 'best-effort',
  callStack: null, stateTransition: null, suggestions: [], approved: true,
});

const setupFakeClaude = (paths: ScenarioPaths): void => {
  const script = `#!/usr/bin/env node\nconst fs=require('fs'),a=process.argv.slice(2),p=${JSON.stringify(paths.invocationPath)};fs.appendFileSync(p,JSON.stringify(a)+'\\n');if(a.includes('--resume')){console.error('session_id not found');process.exit(1)}console.log(JSON.stringify({type:'result',subtype:'success',structured_output:${fakeReviewResultJson},session_id:'fresh-session'}));`;
  const executable = path.join(paths.binDir, 'claude');
  fs.writeFileSync(executable, script);
  fs.chmodSync(executable, 0o755);
};

const writeEarlyRecordClaude = (paths: ScenarioPaths): void => {
  const script = `#!/usr/bin/env node
const fs=require('fs'),a=process.argv.slice(2),p=${JSON.stringify(paths.invocationPath)};
fs.appendFileSync(p,JSON.stringify(a)+'\\n');
const resumeReady=fs.existsSync(${JSON.stringify(paths.resumeReadyPath)});
if(resumeReady&&a.includes('--resume')&&a.includes('early-session')){
  console.log(JSON.stringify({type:'result',subtype:'success',structured_output:${fakeReviewResultJson},session_id:'resumed-session'}));
} else {
  console.log(JSON.stringify({type:'system',subtype:'init',session_id:'early-session'}));
  console.error('simulated review crash');
  process.exit(1);
}`;
  fs.writeFileSync(path.join(paths.binDir, 'claude'), script);
  fs.chmodSync(path.join(paths.binDir, 'claude'), 0o755);
};

const writeCompatibleClaude = (paths: ScenarioPaths): void => {
  const script = `#!/usr/bin/env node\nconst fs=require('fs'),a=process.argv.slice(2),p=${JSON.stringify(paths.invocationPath)};fs.appendFileSync(p,JSON.stringify(a)+'\\n');if(a.includes('--json-schema')&&(!a.includes('--resume')||!a.includes('plan-session'))){console.error('expected plan session');process.exit(1)}console.log(JSON.stringify({type:'result',subtype:'success',structured_output:${fakeReviewResultJson},session_id:'compatible-session'}));`;
  fs.writeFileSync(path.join(paths.binDir, 'claude'), script);
  fs.chmodSync(path.join(paths.binDir, 'claude'), 0o755);
};

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

const scenarioEnv = (paths: ScenarioPaths): NodeJS.ProcessEnv => ({
  ...process.env, HOME: paths.homeDir, PATH: `${paths.binDir}${path.delimiter}${process.env.PATH ?? ''}`, WF_SKIP_CLI_VERSION_CHECK: '1',
});

const assertScenarioResult = (status: number | null, output: string, paths: ScenarioPaths): void => {
  try {
    assertFallbackAssertions(status, output, paths);
    pass('Compiled wf issue retries a stale provider session once and persists the fresh session');
  } catch (error) {
    fail('Compiled wf issue session fallback scenario failed', String(error));
  }
};

const assertPriorCompatibleSessionResult = (status: number | null, output: string, paths: ScenarioPaths): void => {
  try {
    const invocations = readInvocations(paths.invocationPath).filter(args => args.includes('--json-schema'));
    const state = JSON.parse(fs.readFileSync(paths.statePath, 'utf8'));
    assert.strictEqual(status, 0, output);
    assert.strictEqual(invocations.length, 1, JSON.stringify(invocations));
    assert.ok(invocations[0].includes('plan-session'));
    assert.strictEqual(invocations[0].includes('implement-session'), false);
    assert.strictEqual(state.stages.review.providerSessionId, 'compatible-session');
    pass('Compiled wf issue resumes the older compatible session after an incompatible completed stage');
  } catch (error) {
    fail('Compiled wf issue did not select the older compatible session', String(error));
  }
};

const assertInterruptedReviewPersistsEarlySessionId = (
  status: number | null, output: string, paths: ScenarioPaths
): void => {
  try {
    const state = JSON.parse(fs.readFileSync(paths.statePath, 'utf8'));
    assert.notStrictEqual(status, 0, output);
    assert.strictEqual(state.stages.review.providerSessionId, 'early-session', JSON.stringify(state.stages));
    assert.strictEqual(state.stages.review.completedAt, null);
    pass('Interrupted review persists the provider session ID from the first stream event');
  } catch (error) {
    fail('Interrupted review did not persist an early provider session ID', String(error));
  }
};

const assertResumedInvocationUsedEarlySession = (invocationPath: string): void => {
  const invocations = readInvocations(invocationPath).filter(args => args.includes('--json-schema'));
  const resumedInvocation = invocations.at(-1) ?? [];
  assert.ok(resumedInvocation.includes('--resume'), JSON.stringify(resumedInvocation));
  assert.ok(resumedInvocation.includes('early-session'), JSON.stringify(resumedInvocation));
};

const assertResumedReviewUsesEarlySessionId = (
  status: number | null, output: string, paths: ScenarioPaths
): void => {
  try {
    const state = JSON.parse(fs.readFileSync(paths.statePath, 'utf8'));
    assert.strictEqual(status, 0, output);
    assertResumedInvocationUsedEarlySession(paths.invocationPath);
    assert.strictEqual(state.stages.review.providerSessionId, 'resumed-session');
    assert.ok(state.stages.review.completedAt);
    pass('Re-run resumes the interrupted review from the early-recorded provider session');
  } catch (error) {
    fail('Re-run did not resume the review from the early-recorded provider session', String(error));
  }
};

const assertDroppedSessionNamed = (output: string, logContent: string): void => {
  const droppedSessionPattern = /issue\.session\.resume-fallback stage=review .* dropped-session=stale-session/;
  assert.ok(droppedSessionPattern.test(output), output);
  assert.ok(droppedSessionPattern.test(logContent));
};

const assertFallbackAssertions = (status: number | null, output: string, paths: ScenarioPaths): void => {
  const invocations = readInvocations(paths.invocationPath);
  const stageInvocations = invocations.filter((args: string[]) => args.includes('--json-schema'));
  const logPath = path.join(paths.homeDir, '.wf/logs', `agent-${new Date().toISOString().split('T')[0]}.log`);
  const state = JSON.parse(fs.readFileSync(paths.statePath, 'utf8'));
  assert.strictEqual(status, 0, output);
  assert.strictEqual(stageInvocations.length, 2, JSON.stringify(invocations));
  assert.ok(stageInvocations[0].includes('--resume'));
  assert.strictEqual(stageInvocations[1].includes('--resume'), false);
  assert.ok(output.includes('issue.session.resume-fallback'));
  assert.ok(fs.readFileSync(logPath, 'utf8').includes('issue.session.resume-fallback'));
  assertDroppedSessionNamed(output, fs.readFileSync(logPath, 'utf8'));
  assert.strictEqual(state.sessionId, 'wf-session');
  assert.strictEqual(state.stages.review.providerSessionId, 'fresh-session');
};

const readInvocations = (invocationPath: string): string[][] => {
  if (fs.existsSync(invocationPath)) {
    return fs.readFileSync(invocationPath, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  }
  return [];
};

main().catch(error => {
  console.error(error);
  process.exit(1);
});
