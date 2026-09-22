/**
 * Manual smoke test: Markdown-fenced valid plan JSON is accepted without a spurious retry
 *
 * Run: nr test:manual issue-plan-claude-fenced-json-live.smoke.ts
 *
 * Scenario: `resolveStageResponseIssues`/`resolveStageZodIssues` were fixed
 * to use the fence-aware `parseJsonResponse` instead of raw `JSON.parse`. A
 * schema-valid plan wrapped in a ```json code fence must be accepted on
 * pass 1 — it must NOT trigger an unnecessary in-session repair pass.
 *
 * Config under test:
 *   ai: [
 *     { provider: 'anthropic', model: 'claude-sonnet-4-6', default: true }
 *   ]
 *   stages: {
 *     plan: { provider: 'anthropic', backend: 'cli' }
 *   }
 *
 * Verify:
 *   1. The command exits 0 and writes a valid plan artifact.
 *   2. The fake `claude` binary is invoked exactly ONCE (no retry pass fired).
 *   3. The plan artifact's `summary` matches the fenced payload's content.
 *
 * Wire up: fake `claude` script emits a single stream-json result line whose
 * `result` field is the valid plan JSON wrapped in a ```json code fence.
 * Teardown: remove the temp repo, fake executable, and isolated `HOME` tree.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import chalk from 'chalk';
import {
  buildPlanArtifactFilename,
  hashPlanArtifactSources,
} from '../../src/shared/utils/plan-artifact';
import { createReporter, summarise } from './support/reporter';

type SpawnResult = {
  status: number | null;
  stdout: string;
  stderr: string;
};

const projectRoot = path.resolve(__dirname, '../..');
const distMainPath = path.join(projectRoot, 'dist', 'main.js');

const { counts, pass, fail } = createReporter();

const writeExecutable = (filePath: string, content: string): void => {
  fs.writeFileSync(filePath, content, 'utf-8');
  fs.chmodSync(filePath, 0o755);
};

const runCommand = (cwd: string, sourcePath: string, env: NodeJS.ProcessEnv): SpawnResult => {
  const result = spawnSync(
    'node',
    [distMainPath, 'issue:plan', '--action', 'fix', '--custom-plan', sourcePath, '--silent'],
    { cwd, env, encoding: 'utf-8', maxBuffer: 1024 * 1024 * 10 }
  );

  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
};

const validPlanJson = JSON.stringify({
  action: 'fix',
  summary: 'Fenced plan accepted',
  steps: ['Step 1'],
  estimatedComplexity: 'low',
  affectedRepositories: ['repo'],
});

const fencedResult = ['```json', validPlanJson, '```'].join('\n');

const buildFakeClaudeScript = (invocationLogPath: string): string => `#!/usr/bin/env node
const fs = require('fs');
const args = process.argv.slice(2);

fs.appendFileSync(${JSON.stringify(invocationLogPath)}, JSON.stringify(args) + '\\n');

let input = '';
process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('end', () => {
  console.log(JSON.stringify({ type: 'result', subtype: 'success', result: ${JSON.stringify(fencedResult)}, session_id: 'sess-8' }));
});
`;

function readInvocations(logPath: string): string[][] {
  return fs.existsSync(logPath)
    ? fs.readFileSync(logPath, 'utf-8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
    : [];
}

type Paths = {
  homeDir: string;
  repoDir: string;
  binDir: string;
  sourcePath: string;
  configPath: string;
  claudeScriptPath: string;
  invocationLogPath: string;
  planPath: string;
};

function buildPaths(tempRoot: string): Paths {
  const homeDir = path.join(tempRoot, 'home');
  const repoDir = path.join(tempRoot, 'repo');
  const binDir = path.join(tempRoot, 'bin');
  const sourcePath = path.join(repoDir, 'source.md');
  const configPath = path.join(repoDir, 'wf.config.js');
  const claudeScriptPath = path.join(binDir, 'claude');
  const invocationLogPath = path.join(tempRoot, 'invocations.log');
  const repoName = path.basename(repoDir);
  const sourceStem = path.basename(sourcePath, '.md');
  const planFilename = buildPlanArtifactFilename({ hash: hashPlanArtifactSources([sourceStem]), action: 'fix', format: 'json' });
  const artifactDir = path.join(homeDir, '.wf', repoName);
  const planPath = path.join(artifactDir, planFilename);
  return { homeDir, repoDir, binDir, sourcePath, configPath, claudeScriptPath, invocationLogPath, planPath };
}

function buildConfigContent(): string {
  return [
    'module.exports = {',
    '  ai: [',
    "    { provider: 'anthropic', model: 'claude-sonnet-4-6', default: true, apiKey: 'test-key' },",
    '  ],',
    '  stages: {',
    "    plan: { provider: 'anthropic', backend: 'cli', model: 'claude-sonnet-4-6' },",
    '  },',
    '};',
    '',
  ].join('\n');
}

function writeConfigFile(configPath: string): void {
  fs.writeFileSync(configPath, buildConfigContent(), 'utf-8');
}

function setupWorkspace(opts: Omit<Paths, 'planPath'>): NodeJS.ProcessEnv {
  fs.mkdirSync(opts.repoDir, { recursive: true });
  fs.mkdirSync(opts.binDir, { recursive: true });
  fs.mkdirSync(opts.homeDir, { recursive: true });
  fs.mkdirSync(path.join(opts.homeDir, '.wf', 'logs'), { recursive: true });
  fs.mkdirSync(path.join(opts.homeDir, '.wf', 'state'), { recursive: true });
  writeConfigFile(opts.configPath);
  fs.writeFileSync(opts.sourcePath, ['# Smoke source', '', 'This file forces the real plan stage to invoke the CLI backend.', ''].join('\n'), 'utf-8');
  writeExecutable(opts.claudeScriptPath, buildFakeClaudeScript(opts.invocationLogPath));
  return { ...process.env, HOME: opts.homeDir, PATH: `${opts.binDir}${path.delimiter}${process.env.PATH ?? ''}`, WF_SKIP_CLI_VERSION_CHECK: '1' };
}

function runScenario(paths: ReturnType<typeof buildPaths>): { result: SpawnResult; invocations: string[][] } {
  const env = setupWorkspace(paths);
  const result = runCommand(paths.repoDir, paths.sourcePath, env);
  const invocations = readInvocations(paths.invocationLogPath);
  return { result, invocations };
}

function checkCommandExitsZero(result: SpawnResult, output: string): void {
  if (result.status === 0) {
    pass('command exits 0');
  } else {
    fail('command should exit 0', output);
  }
}

function checkPlanArtifactWritten(planPath: string, output: string): void {
  if (fs.existsSync(planPath)) {
    pass('a plan artifact was written');
  } else {
    fail('expected a plan artifact to be written', `planPath: ${planPath}\noutput:\n${output}`);
  }
}

function checkSingleInvocation(invocations: string[][]): void {
  if (invocations.length === 1) {
    pass('fake claude binary was invoked exactly once (no spurious retry)');
  } else {
    fail('expected exactly 1 claude invocation', `got ${invocations.length}: ${JSON.stringify(invocations)}`);
  }
}

function checkArtifactSummary(planPath: string, expectedSummary: string): void {
  if (!fs.existsSync(planPath)) return;
  const artifact = JSON.parse(fs.readFileSync(planPath, 'utf-8'));
  if (artifact.summary === expectedSummary) {
    pass('plan artifact reflects the fenced payload content');
  } else {
    fail('plan artifact should reflect the fenced payload', JSON.stringify(artifact.summary));
  }
}

function checkBuildExists(): void {
  if (!fs.existsSync(distMainPath)) {
    fail('dist/main.js must exist before running this smoke test', 'Run `yarn build` first.');
    process.exit(1);
  }
}

function runChecks(paths: Paths): void {
  const { result, invocations } = runScenario(paths);
  const output = `${result.stdout}\n${result.stderr}`;
  checkCommandExitsZero(result, output);
  checkPlanArtifactWritten(paths.planPath, output);
  checkSingleInvocation(invocations);
  checkArtifactSummary(paths.planPath, 'Fenced plan accepted');
}

async function main(): Promise<void> {
  checkBuildExists();
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-claude-fenced-json-'));
  const paths = buildPaths(tempRoot);
  try {
    runChecks(paths);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
  summarise(counts);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
