/**
 * Manual smoke test: inactivity timeout fires during a text-only agent stream
 *
 * Run: nr test:manual codex-inactivity-ignores-agent-text-live.smoke
 *
 * Scenario: Before this fix, every NDJSON message — including plain agent
 * text — reset the 2-minute inactivity timer, so a chatty-but-stuck codex
 * child could survive indefinitely by talking, bounded only by the
 * 15-minute wall clock. Now only real activity (command execution, file
 * changes, tool calls) resets the inactivity timer. This must be provable
 * as a live subprocess kill, distinguishable from the no-progress cap
 * (count-based) by using fewer than 10 messages spread past the window.
 *
 * Config under test:
 *   ai: [{ provider: 'openai', model: 'gpt-5.4', default: true }]
 *   stages: {
 *     implement: { provider: 'openai', backend: 'cli', inactivityTimeoutMs: 500 }
 *   }
 *
 * Verify:
 *   1. A fake codex binary emitting one agent_message every 300ms, forever,
 *      is killed within ~2s of the last message, well before it would have
 *      emitted its 8th tick naturally.
 *   2. The terminal message reports subtype=inactivity_timeout, NOT
 *      no_progress — fewer than 10 agent messages will have been emitted.
 *   3. The same fake binary emitting a command_execution heartbeat instead
 *      of agent text, on the same schedule and timeout, runs to its natural
 *      completion without being killed early.
 *
 * Wire up: same temp-repo + fake-executable-on-PATH harness as
 * codex-cli-version-flag-live.smoke.ts, with a Node script as the fake
 * codex binary so the drip has real wall-clock gaps between NDJSON lines.
 * Teardown: remove the temp repo, fake binaries, and isolated HOME tree.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import chalk from 'chalk';
import {
  buildPlanArtifactFilename,
  hashPlanArtifactSources,
  writePlanArtifactManifest,
} from '../../src/shared/utils/plan-artifact';
import { createReporter, summarise } from './support/reporter';

const projectRoot = path.resolve(__dirname, '../..');
const distMainPath = path.join(projectRoot, 'dist', 'main.js');
const TICK_MS = 300;
const TICK_COUNT = 8;

const { counts, pass, fail } = createReporter();

const writeExecutable = (filePath: string, content: string): void => {
  fs.writeFileSync(filePath, content, 'utf-8');
  fs.chmodSync(filePath, 0o755);
};

type TempRepo = { tempRoot: string; repoDir: string; binDir: string; homeDir: string; planPath: string };

const buildPlanJson = (repoName: string): string => JSON.stringify({
  action: 'fix',
  summary: 'smoke test plan',
  steps: ['step 1'],
  estimatedComplexity: 'low',
  affectedFiles: [],
  affectedRepositories: [repoName],
  risks: [],
});

const buildWfConfig = (): string => [
  'module.exports = {',
  '  ai: [',
  "    { provider: 'openai', model: 'gpt-5.4', default: true, apiKey: 'test-key' },",
  '  ],',
  '  stages: {',
  "    implement: { provider: 'openai', backend: 'cli', inactivityTimeoutMs: 500 },",
  '  },',
  '};',
  '',
].join('\n');

const buildDripScript = (buildItem: string): string => [
  '#!/usr/bin/env node',
  "if (process.argv.includes('--version')) { console.log('codex-cli 0.150.0'); process.exit(0); }",
  "console.log(JSON.stringify({ type: 'thread.started', thread_id: 'tid-smoke' }));",
  'let tick = 0;',
  'const interval = setInterval(() => {',
  '  tick++;',
  `  console.log(JSON.stringify(${buildItem}));`,
  `  if (tick >= ${TICK_COUNT}) clearInterval(interval);`,
  `}, ${TICK_MS});`,
  '',
].join('\n');

const agentTextDripScript = (): string => buildDripScript(
  "{ type: 'item.completed', item: { type: 'agent_message', text: 'tick ' + tick } }",
);

const commandHeartbeatDripScript = (): string => buildDripScript(
  "{ type: 'item.completed', item: { type: 'command_execution', command: 'true', exit_code: 0 } }",
);

const createTempDirectories = (homeDir: string, repoDir: string, binDir: string): void => {
  fs.mkdirSync(repoDir, { recursive: true });
  fs.mkdirSync(binDir, { recursive: true });
  fs.mkdirSync(homeDir, { recursive: true });
  fs.mkdirSync(path.join(homeDir, '.wf', 'logs'), { recursive: true });
  fs.mkdirSync(path.join(homeDir, '.wf', 'state'), { recursive: true });
};

const initGitRepo = (repoDir: string): void => {
  spawnSync('git', ['init'], { cwd: repoDir, stdio: 'pipe' });
  spawnSync('git', ['config', 'user.email', 'test@test.com'], { cwd: repoDir, stdio: 'pipe' });
  spawnSync('git', ['config', 'user.name', 'Test'], { cwd: repoDir, stdio: 'pipe' });
  fs.writeFileSync(path.join(repoDir, 'wf.config.js'), buildWfConfig(), 'utf-8');
  fs.writeFileSync(path.join(repoDir, 'README.md'), '# Smoke\n', 'utf-8');
  spawnSync('git', ['add', '.'], { cwd: repoDir, stdio: 'pipe' });
  spawnSync('git', ['commit', '-m', 'init'], { cwd: repoDir, stdio: 'pipe' });
};

const writePlanArtifact = (homeDir: string, repoName: string): string => {
  const sourceStem = 'source';
  const hash = hashPlanArtifactSources([sourceStem]);
  const planFilename = buildPlanArtifactFilename({ hash, action: 'fix', format: 'json' });
  const artifactDir = path.join(homeDir, '.wf', repoName);
  fs.mkdirSync(artifactDir, { recursive: true });
  const planPath = path.join(artifactDir, planFilename);
  fs.writeFileSync(planPath, buildPlanJson(repoName), 'utf-8');
  writePlanManifest(planPath, hash, sourceStem);
  return planPath;
};

const writePlanManifest = (planPath: string, hash: string, sourceStem: string): void => {
  writePlanArtifactManifest({
    artifactPath: planPath,
    action: 'fix',
    createdAt: new Date().toISOString(),
    hash,
    format: 'json',
    sourceKind: 'custom',
    sourceName: sourceStem,
  });
};

const setupTempRepo = (prefix: string): TempRepo => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const homeDir = path.join(tempRoot, 'home');
  const repoDir = path.join(tempRoot, 'repo');
  const binDir = path.join(tempRoot, 'bin');
  const repoName = path.basename(repoDir);
  createTempDirectories(homeDir, repoDir, binDir);
  initGitRepo(repoDir);
  const planPath = writePlanArtifact(homeDir, repoName);
  return { tempRoot, repoDir, binDir, homeDir, planPath };
};

type RunResult = { exitCode: number | null; output: string; elapsedMs: number };

const buildImplementEnv = (repo: TempRepo): NodeJS.ProcessEnv => ({
  ...process.env,
  HOME: repo.homeDir,
  PATH: `${repo.binDir}${path.delimiter}${process.env['PATH'] ?? ''}`,
});

const runImplement = (repo: TempRepo): RunResult => {
  const startedAt = Date.now();
  const result = spawnSync(
    'node',
    [distMainPath, 'issue:implement', repo.planPath, '--silent', '--no-branch'],
    { cwd: repo.repoDir, env: buildImplementEnv(repo), encoding: 'utf-8', maxBuffer: 1024 * 1024 * 10, timeout: 15_000 },
  );
  return {
    exitCode: result.status,
    output: `${result.stdout ?? ''}\n${result.stderr ?? ''}`,
    elapsedMs: Date.now() - startedAt,
  };
};

const naturalCompletionMs = TICK_MS * TICK_COUNT;

const verifyKilledByInactivity = (result: RunResult): void => {
  const killedEarly = result.elapsedMs < naturalCompletionMs;
  if (killedEarly) pass(`text-only drip killed early (elapsed=${result.elapsedMs}ms)`);
  else fail('text-only drip was not killed early', `elapsed=${result.elapsedMs}ms`);
};

const verifyReportedAsInactivityTimeout = (result: RunResult): void => {
  const isInactivity = result.output.includes('inactivity_timeout');
  const isNoProgress = result.output.includes('no_progress');
  if (isInactivity && !isNoProgress) {
    pass('failure reports subtype=inactivity_timeout, not no_progress');
    return;
  }
  fail('failure did not report inactivity_timeout distinctly', result.output.slice(0, 500));
};

const verifyTextOnlyDripKilled = (): void => {
  const repo = setupTempRepo('wf-inactivity-text-');
  try {
    writeExecutable(path.join(repo.binDir, 'codex'), agentTextDripScript());
    const result = runImplement(repo);
    verifyKilledByInactivity(result);
    verifyReportedAsInactivityTimeout(result);
  } finally {
    fs.rmSync(repo.tempRoot, { recursive: true, force: true });
  }
};

const verifyCommandHeartbeatSurvives = (): void => {
  const repo = setupTempRepo('wf-inactivity-cmd-');
  try {
    writeExecutable(path.join(repo.binDir, 'codex'), commandHeartbeatDripScript());
    const result = runImplement(repo);
    const ranToCompletion = result.elapsedMs >= naturalCompletionMs && !result.output.includes('inactivity_timeout');
    if (ranToCompletion) pass(`command heartbeat survives past the inactivity window (elapsed=${result.elapsedMs}ms)`);
    else fail('command heartbeat was killed early', `elapsed=${result.elapsedMs}ms output=${result.output.slice(0, 500)}`);
  } finally {
    fs.rmSync(repo.tempRoot, { recursive: true, force: true });
  }
};

const verifyDistMain = (): void => {
  if (fs.existsSync(distMainPath)) {
    pass('dist/main.js exists');
    return;
  }
  fail('dist/main.js must exist', 'Run `yarn build` first.');
  process.exit(1);
};

async function main(): Promise<void> {
  console.log(chalk.bold.cyan('\n  Codex inactivity ignores agent text — live smoke test\n'));
  verifyDistMain();
  verifyTextOnlyDripKilled();
  verifyCommandHeartbeatSurvives();
  summarise(counts);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
