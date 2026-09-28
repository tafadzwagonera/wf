import assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { createReporter, summarise } from './support/reporter';
import {
  buildPlanArtifactFilename,
  buildPlanArtifactManifest,
  hashPlanArtifactSources,
  writePlanArtifactManifest,
} from '../../src/shared/utils/plan-artifact';

const distPromptPath = path.join(__dirname, '../../dist/shared/utils/provider-session-prompt.js');
const { counts, pass, fail } = createReporter();

async function main(): Promise<void> {
  assertCompiledArtifacts();
  const selection = await selectLatestRecordedSession();
  assertLatestSelection(selection);
  await assertInteractiveSelections();
  runCompiledIssueFallbackScenario();
  summarise(counts);
}

const assertCompiledArtifacts = (): void => {
  if (fs.existsSync(path.join(__dirname, '../../dist/main.js')) && fs.existsSync(distPromptPath)) return;
  throw new Error('dist/main.js and the compiled provider-session prompt must exist. Run `yarn build` first.');
};

const selectLatestRecordedSession = async (): Promise<Record<string, unknown>> => {
  const { selectProviderSession } = require(distPromptPath) as {
    selectProviderSession: (options: Record<string, unknown>) => Promise<Record<string, unknown>>;
  };
  const candidate = {
    stage: 'plan', provider: 'anthropic', backend: 'cli',
    providerSessionId: 'recorded-session', recordedAt: '2026-09-28T10:00:00.000Z',
  };
  return selectProviderSession({
    candidate,
    fingerprint: { provider: 'anthropic', backend: 'cli' },
    interactive: false,
  });
};

const assertLatestSelection = (selection: Record<string, unknown>): void => {
  try {
    assert.deepStrictEqual(selection, {
      kind: 'latest', stage: 'plan', providerSessionId: 'recorded-session',
    });
    pass('Compiled provider-session selector reuses the latest compatible session non-interactively');
  } catch (error) {
    fail('Compiled provider-session selector did not reuse the latest compatible session', String(error));
  }
};

const assertInteractiveSelections = async (): Promise<void> => {
  const inquirer = require('inquirer') as { prompt: (questions: unknown[]) => Promise<Record<string, string>> };
  const originalPrompt = inquirer.prompt;
  inquirer.prompt = createInteractivePrompt();
  try {
    await runInteractiveSelections();
    pass('Compiled provider-session selector supports latest, provided, and new interactive choices');
  } catch (error) {
    fail('Compiled provider-session selector interactive choices failed', String(error));
  } finally {
    inquirer.prompt = originalPrompt;
  }
};

const createInteractivePrompt = (): (() => Promise<Record<string, string>>) => {
  const responses = [{ selected: 'latest' }, { selected: 'provided' }, { providerSessionId: ' supplied-session ' }, { selected: 'new' }];
  return async () => responses.shift() ?? {};
};

const runInteractiveSelections = async (): Promise<void> => {
  const { selectProviderSession } = require(distPromptPath) as {
    selectProviderSession: (options: Record<string, unknown>) => Promise<Record<string, unknown>>;
  };
  const options = { candidate: promptCandidate(), fingerprint: { provider: 'anthropic', backend: 'cli' }, interactive: true };
  const latest = await selectProviderSession(options);
  const provided = await selectProviderSession(options);
  const fresh = await selectProviderSession(options);
  assert.deepStrictEqual(latest, { kind: 'latest', stage: 'plan', providerSessionId: 'recorded-session' });
  assert.deepStrictEqual(provided, { kind: 'provided', providerSessionId: 'supplied-session' });
  assert.deepStrictEqual(fresh, { kind: 'new' });
};

const promptCandidate = () => ({
  stage: 'plan', provider: 'anthropic' as const, backend: 'cli' as const,
  providerSessionId: 'recorded-session', recordedAt: '2026-09-28T10:00:00.000Z',
});

const runCompiledIssueFallbackScenario = (): void => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-session-resume-'));
  try {
    const paths = createScenarioPaths(tempRoot);
    setupScenario(paths);
    const result = spawnSync(process.execPath, [
      path.join(__dirname, '../../dist/main.js'), 'issue', '--session-id', 'wf-session',
      '--ticket-key', 'RESUME-1', '--from', 'review', '--to', 'review', '--silent',
    ], { cwd: paths.repoDir, encoding: 'utf8', env: scenarioEnv(paths) });
    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
    assertScenarioResult(result.status, output, paths);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
};

type ScenarioPaths = { homeDir: string; repoDir: string; binDir: string; statePath: string; invocationPath: string };

const createScenarioPaths = (tempRoot: string): ScenarioPaths => ({
  homeDir: path.join(tempRoot, 'home'), repoDir: path.join(tempRoot, 'repo'), binDir: path.join(tempRoot, 'bin'),
  statePath: path.join(tempRoot, 'home/.wf/state/sessions/RESUME-1-wf-session.json'),
  invocationPath: path.join(tempRoot, 'invocations.log'),
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
    customPlanRef: null, sourceBranch: 'main', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), completedAt: null,
    stages: { implement: { config: { provider: 'anthropic', backend: 'cli' }, model: 'claude', modelsUsed: [], providerSessionId: 'stale-session', summary: null, startedAt: new Date().toISOString(), completedAt: new Date().toISOString() } },
  }));
};

const setupFakeClaude = (paths: ScenarioPaths): void => {
  const reviewResult = JSON.stringify({
    summary: 'ok', issues: [], executionMode: 'cli', repairStrategy: null, traceProvenance: 'best-effort',
    callStack: null, stateTransition: null, suggestions: [], approved: true,
  });
  const script = `#!/usr/bin/env node\nconst fs=require('fs'),a=process.argv.slice(2),p=${JSON.stringify(paths.invocationPath)};fs.appendFileSync(p,JSON.stringify(a)+'\\n');if(a.includes('--resume')){console.error('session_id not found');process.exit(1)}console.log(JSON.stringify({type:'result',subtype:'success',structured_output:${reviewResult},session_id:'fresh-session'}));`;
  const executable = path.join(paths.binDir, 'claude');
  fs.writeFileSync(executable, script);
  fs.chmodSync(executable, 0o755);
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

const assertFallbackAssertions = (status: number | null, output: string, paths: ScenarioPaths): void => {
  const invocations = readInvocations(paths.invocationPath);
  const stageInvocations = invocations.filter((args: string[]) => args.includes('--json-schema'));
  const logPath = path.join(paths.homeDir, '.wf/logs', `agent-${new Date().toISOString().split('T')[0]}.log`);
  const state = JSON.parse(fs.readFileSync(paths.statePath, 'utf8'));
  assert.strictEqual(status, 0, output);
  assert.strictEqual(stageInvocations.length, 2, JSON.stringify(invocations));
  assert.ok(stageInvocations[0].includes('--resume'));
  assert.ok(!stageInvocations[1].includes('--resume'));
  assert.ok(output.includes('issue.session.resume-fallback'));
  assert.ok(fs.readFileSync(logPath, 'utf8').includes('issue.session.resume-fallback'));
  assert.strictEqual(state.sessionId, 'wf-session');
  assert.strictEqual(state.stages.review.providerSessionId, 'fresh-session');
};

const readInvocations = (invocationPath: string): string[][] => {
  if (!fs.existsSync(invocationPath)) return [];
  return fs.readFileSync(invocationPath, 'utf8').trim().split('\n').map(line => JSON.parse(line));
};

main().catch(error => {
  console.error(error);
  process.exit(1);
});
