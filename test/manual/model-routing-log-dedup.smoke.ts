/**
 * Manual smoke test: model routing log line no longer duplicates the resolved model
 *
 * Run: nr test:manual model-routing-log-dedup.smoke
 *
 * Scenario: `resolveModelRouting`'s `logMessage` used to embed the resolved
 * model name alongside the routing reason, duplicating the `llm.adapter
 * resolved-model=...` line the codex-cli adapter already prints one line
 * above it. `buildRoutingResult` in shared-routing.ts was changed to drop the
 * model from `logMessage`, leaving only `[{adapterLabel}] Model routing:
 * {suffix}`. A live `issue:implement` run through the codex-cli backend must
 * print the new format and must not reprint the resolved model in that line.
 *
 * Config under test:
 *   ai: [{ provider: 'openai', model: 'gpt-5.4', default: true }]
 *   stages: { implement: { provider: 'openai', backend: 'cli' } }
 *
 * Verify:
 *   1. Live stdout from `node dist/main.js issue:implement` (fake `codex`
 *      binary on PATH, plan with estimatedComplexity 'low') contains the
 *      line `Model routing: auto — mechanical: low complexity task (0 files)`
 *   2. That same stdout line does not contain the resolved model string
 *      (`gpt-5.4`) — it must appear only on the preceding `llm.adapter
 *      resolved-model=` line, not duplicated onto the `Model routing:` line
 *   3. The resolved model (`gpt-5.4`) is still observable on an `llm.adapter`
 *      log line elsewhere in stdout, so dropping it from the routing line
 *      does not remove the only place it was logged
 *
 * Wire up: reuse the temp-repo + fake-executable-on-PATH harness from
 * codex-no-progress-abort-live.smoke.ts — write a plan artifact with
 * estimatedComplexity 'low', a fake `codex` binary that emits one
 * item.completed/agent_message "done" event and exits 0, then invoke `node
 * dist/main.js issue:implement` against it and assert on captured stdout.
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

const { counts, pass, fail } = createReporter();

const writeExecutable = (filePath: string, content: string): void => {
  fs.writeFileSync(filePath, content, 'utf-8');
  fs.chmodSync(filePath, 0o755);
};

type TempRepo = {
  tempRoot: string;
  repoDir: string;
  binDir: string;
  homeDir: string;
  planPath: string;
};

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
  "    implement: { provider: 'openai', backend: 'cli' },",
  '  },',
  '};',
  '',
].join('\n');

const buildDoneScript = (): string => [
  '#!/bin/sh',
  'if [ "$1" = "--version" ]; then',
  '  echo "codex-cli 0.150.0"',
  '  exit 0',
  'fi',
  'echo \'{"type":"thread.started","thread_id":"tid-smoke"}\'',
  'echo \'{"type":"item.completed","item":{"type":"agent_message","text":"Implementation complete."}}\'',
  '',
].join('\n');

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

type RunResult = { exitCode: number | null; output: string };

const runImplement = (repo: TempRepo, timeoutMs: number): RunResult => {
  const env = {
    ...process.env,
    HOME: repo.homeDir,
    PATH: `${repo.binDir}${path.delimiter}${process.env['PATH'] ?? ''}`,
  };
  const result = spawnSync(
    'node',
    [distMainPath, 'issue:implement', repo.planPath, '--silent', '--no-branch'],
    { cwd: repo.repoDir, env, encoding: 'utf-8', maxBuffer: 1024 * 1024 * 10, timeout: timeoutMs },
  );
  return { exitCode: result.status, output: `${result.stdout ?? ''}\n${result.stderr ?? ''}` };
};

const verifyRoutingLineDedupesModel = (result: RunResult): void => {
  const lines = result.output.split('\n');
  const routingLine = lines.find(line => line.includes('Model routing:'));
  if (!routingLine) {
    fail('stdout must contain a "Model routing:" line', result.output.slice(0, 500));
    return;
  }
  const expected = 'Model routing: auto — mechanical: low complexity task (0 files)';
  if (routingLine.includes(expected)) {
    pass('routing line matches the deduped format');
  } else {
    fail('routing line does not match the deduped format', routingLine);
  }
  if (routingLine.includes('gpt-5.4')) {
    fail('routing line still duplicates the resolved model', routingLine);
  } else {
    pass('routing line omits the resolved model');
  }
};

const verifyResolvedModelStillLoggedElsewhere = (result: RunResult): void => {
  const lines = result.output.split('\n');
  const modelLoggedOutsideRoutingLine = lines.some(
    line => line.includes('gpt-5.4') && !line.includes('Model routing:'),
  );
  if (modelLoggedOutsideRoutingLine) {
    pass('resolved model gpt-5.4 is still observable on the llm.adapter line');
  } else {
    fail('resolved model gpt-5.4 is no longer logged anywhere', result.output.slice(0, 500));
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
  console.log(chalk.bold.cyan('\n  Model routing log dedup — live smoke test\n'));
  verifyDistMain();
  const repo = setupTempRepo('wf-model-routing-log-');
  try {
    writeExecutable(path.join(repo.binDir, 'codex'), buildDoneScript());
    const result = runImplement(repo, 30_000);
    verifyRoutingLineDedupesModel(result);
    verifyResolvedModelStillLoggedElsewhere(result);
  } finally {
    fs.rmSync(repo.tempRoot, { recursive: true, force: true });
  }
  summarise(counts);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
