/**
 * Manual smoke test: ten consecutive agent-text messages with no command/file activity abort the codex run as stalled
 *
 * Run: nr test:manual codex-no-progress-abort-live.smoke
 *
 * Scenario: A codex child that keeps emitting item.completed/agent_message
 * events without ever running a command, editing a file, or calling a tool
 * is indistinguishable from the 2026-09-30 incident where the CLI argued
 * with a blocking Stop hook for 40+ turns. The runner must kill the child
 * and surface a no_progress stall after MAX_CONSECUTIVE_AGENT_MESSAGES (10)
 * consecutive text-only messages, and it must not fire early when real work
 * interleaves.
 *
 * Config under test:
 *   ai: [{ provider: 'openai', model: 'gpt-5.4', default: true }]
 *   stages: { implement: { provider: 'openai', backend: 'cli' } }
 *
 * Verify:
 *   1. A fake codex binary that emits 15 consecutive agent_message events
 *      (no other item types) causes the live `node dist/main.js
 *      issue:implement` run to exit non-zero, reporting subtype=no_progress
 *      rather than draining to a normal completion.
 *   2. A second fake codex binary that interleaves one command_execution
 *      item.completed every 5 agent_message events, for 30 total
 *      agent_message events, does NOT trigger the abort.
 *
 * Note: the failure's `category: 'stall'` classification is unit-tested
 * (codex-cli.adapter.spec.ts, stage-agent.service.spec.ts) — it isn't
 * surfaced in CLI stdout, so a live check of it here would be redundant
 * with those tests and unable to observe anything they don't already.
 *
 * Wire up: same temp-repo + fake-executable-on-PATH harness as
 * codex-cli-version-flag-live.smoke.ts — write a plan artifact, then invoke
 * `node dist/main.js issue:implement` against it with the fake codex on PATH.
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
} from '../../src/common/utils/plan-artifact';
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

const agentMessageLine = (): string =>
  JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'still working on it' } });

const commandCompletedLine = (): string =>
  JSON.stringify({ type: 'item.completed', item: { type: 'command_execution', command: 'true', exit_code: 0 } });

const buildTextOnlyLoopScript = (): string => [
  '#!/bin/sh',
  'if [ "$1" = "--version" ]; then',
  '  echo "codex-cli 0.150.0"',
  '  exit 0',
  'fi',
  'echo \'{"type":"thread.started","thread_id":"tid-smoke"}\'',
  ...Array.from({ length: 15 }, () => `echo '${agentMessageLine()}'`),
  '',
].join('\n');

const buildInterleavedScript = (): string => {
  const lines = ['#!/bin/sh', 'if [ "$1" = "--version" ]; then', '  echo "codex-cli 0.150.0"', '  exit 0', 'fi'];
  lines.push('echo \'{"type":"thread.started","thread_id":"tid-smoke"}\'');
  for (let i = 0; i < 30; i++) {
    lines.push(`echo '${agentMessageLine()}'`);
    if ((i + 1) % 5 === 0) lines.push(`echo '${commandCompletedLine()}'`);
  }
  lines.push('echo \'{"type":"item.completed","item":{"type":"agent_message","text":"Implementation complete."}}\'');
  lines.push('');
  return lines.join('\n');
};

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

const verifyAbortedAsNoProgress = (result: RunResult): void => {
  const hasNoProgress = result.output.includes('no_progress');
  if (result.exitCode !== 0 && hasNoProgress) {
    pass('a 15-message text-only loop is aborted and reported as no_progress');
    return;
  }
  fail(
    'a 15-message text-only loop was not aborted as no_progress',
    `exitCode=${result.exitCode} output=${result.output.slice(0, 500)}`,
  );
};

const verifyTextOnlyLoopAborts = (): void => {
  const repo = setupTempRepo('wf-no-progress-');
  try {
    writeExecutable(path.join(repo.binDir, 'codex'), buildTextOnlyLoopScript());
    const result = runImplement(repo, 30_000);
    verifyAbortedAsNoProgress(result);
  } finally {
    fs.rmSync(repo.tempRoot, { recursive: true, force: true });
  }
};

const verifyInterleavedWorkDoesNotAbort = (): void => {
  const repo = setupTempRepo('wf-no-progress-ok-');
  try {
    writeExecutable(path.join(repo.binDir, 'codex'), buildInterleavedScript());
    const result = runImplement(repo, 30_000);
    if (result.output.includes('no_progress')) {
      fail('interleaved command activity did not prevent the no_progress abort', result.output.slice(0, 500));
    } else {
      pass('30 agent messages interleaved with command activity every 5th message do not trigger the abort');
    }
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
  console.log(chalk.bold.cyan('\n  Codex no-progress abort — live smoke test\n'));
  verifyDistMain();
  verifyTextOnlyLoopAborts();
  verifyInterleavedWorkDoesNotAbort();
  summarise(counts);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
