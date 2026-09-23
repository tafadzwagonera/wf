/**
 * Manual smoke test: Codex stall on the repair pass propagates unretried, unmasked as parse
 *
 * Run: nr test:manual issue-plan-codex-repair-pass-stall-live.smoke.ts
 *
 * Scenario: A stall (empty result) on the REPAIR pass specifically must not
 * be swallowed by `runCodexRetryPass`'s try/catch and relabeled as a parse
 * failure — `isNonRetryableCodexError` must let `stall`/`truncation`
 * categories through unmodified. Distinguishes this from the "thread not
 * found" repair-pass-failure case.
 *
 * Config under test:
 *   ai: [
 *     { provider: 'openai', model: 'gpt-5.4', default: true }
 *   ]
 *   stages: {
 *     plan: { provider: 'openai', backend: 'cli' }
 *   }
 *
 * Verify:
 *   1. The command exits non-zero.
 *   2. CLI output shows the repair pass genuinely stalled (empty Codex
 *      result), NOT the resolution-plan parse-failure message — proving
 *      `isNonRetryableCodexError` let the stall through unmasked.
 *   3. The first two invocations are the constrained schema pass and its
 *      resumed empty repair pass; any later fallback omits `--output-schema`.
 *   4. No plan artifact is written.
 *
 * Wire up: fake `codex` script — first invocation emits `thread.started` +
 * phase-nested JSON; second invocation (the repair pass) emits
 * `thread.started` only, no `item.completed` message (an empty agent turn).
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

const incidentShapeJson = JSON.stringify({
  action: 'fix',
  summary: 'partial plan',
  phases: [{ name: 'Phase 1', steps: ['step 1'], verificationCheckpoint: 'verify' }],
});

function buildStdinSection(): string {
  return `let input = '';
process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('end', () => {
  if (isResume) {
    console.log(JSON.stringify({ type: 'thread.started', thread_id: 'tid-4' }));
    return;
  }
  console.log(JSON.stringify({ type: 'thread.started', thread_id: 'tid-4' }));
  console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: ${JSON.stringify(incidentShapeJson)} } }));
});`;
}

const buildFakeCodexScript = (invocationLogPath: string): string => `#!/usr/bin/env node
const fs = require('fs');
const args = process.argv.slice(2);

if (args[0] === '--version') {
  console.log('codex-cli 0.142.5');
  process.exit(0);
}

fs.appendFileSync(${JSON.stringify(invocationLogPath)}, JSON.stringify(args) + '\\n');

const isResume = args.includes('resume');

${buildStdinSection()}
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
  codexScriptPath: string;
  codexAliasPath: string;
  invocationLogPath: string;
  planPath: string;
};

type BasicCodexStallPaths = Omit<Paths, 'planPath'>;

function buildBasicCodexStallPaths(tempRoot: string): BasicCodexStallPaths {
  const homeDir = path.join(tempRoot, 'home');
  const repoDir = path.join(tempRoot, 'repo');
  const binDir = path.join(tempRoot, 'bin');
  return {
    homeDir,
    repoDir,
    binDir,
    sourcePath: path.join(repoDir, 'source.md'),
    configPath: path.join(repoDir, 'wf.config.js'),
    codexScriptPath: path.join(binDir, 'codex'),
    codexAliasPath: path.join(binDir, 'Codex'),
    invocationLogPath: path.join(tempRoot, 'invocations.log'),
  };
}

function buildCodexStallPlanPath(homeDir: string, repoDir: string, sourcePath: string): string {
  const repoName = path.basename(repoDir);
  const sourceStem = path.basename(sourcePath, '.md');
  const planFilename = buildPlanArtifactFilename({
    hash: hashPlanArtifactSources([sourceStem]),
    action: 'fix',
    format: 'json',
  });
  return path.join(homeDir, '.wf', repoName, planFilename);
}

function buildPaths(tempRoot: string): Paths {
  const basic = buildBasicCodexStallPaths(tempRoot);
  return {
    ...basic,
    planPath: buildCodexStallPlanPath(basic.homeDir, basic.repoDir, basic.sourcePath),
  };
}

function buildConfigContent(): string {
  return [
    'module.exports = {',
    '  ai: [',
    "    { provider: 'openai', model: 'gpt-5.4', default: true },",
    '  ],',
    '  stages: {',
    "    plan: { provider: 'openai', backend: 'cli', model: 'gpt-5.4' },",
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
  writeExecutable(opts.codexAliasPath, ['#!/bin/sh', 'exit 0', ''].join('\n'));
  writeExecutable(opts.codexScriptPath, buildFakeCodexScript(opts.invocationLogPath));
  return { ...process.env, HOME: opts.homeDir, PATH: `${opts.binDir}${path.delimiter}${process.env.PATH ?? ''}`, WF_SKIP_CLI_VERSION_CHECK: '1' };
}

function runScenario(paths: Paths): { result: SpawnResult; invocations: string[][] } {
  const env = setupWorkspace(paths);
  const result = runCommand(paths.repoDir, paths.sourcePath, env);
  const invocations = readInvocations(paths.invocationLogPath);
  return { result, invocations };
}

function checkCommandExitsNonZero(result: SpawnResult, output: string): void {
  if (result.status !== 0) {
    pass('command exits non-zero');
  } else {
    fail('command should exit non-zero on a repair-pass stall', output);
  }
}

function checkStallDiagnostic(output: string): void {
  if (output.includes('No result message received from Codex CLI')) {
    pass('output shows the repair pass genuinely stalled (empty Codex result), not a schema miss');
  } else {
    fail('output should show a stalled repair pass', output);
  }
}

function checkStallNotMaskedAsParseFailure(output: string): void {
  if (output.includes('Failed to parse resolution plan from agent response')) {
    fail('stall should not be masked as a parse failure', output);
  } else {
    pass('stall is not relabeled as a resolution-plan parse failure');
  }
}

function checkSchemaRepairBoundary(invocations: string[][]): void {
  const [initial, repair, ...fallbacks] = invocations;
  const initialIsConstrained = initial?.includes('--output-schema') ?? false;
  const repairIsConstrainedResume = repair?.includes('resume') && repair.includes('--output-schema');
  if (initialIsConstrained && repairIsConstrainedResume) {
    pass('initial and resumed repair passes use the constrained schema');
  } else {
    fail('expected constrained initial and resumed repair invocations', JSON.stringify(invocations));
  }
  const fallbackIsUnconstrained = fallbacks.every(args => args.filter(arg => arg === '--output-schema').length === 0);
  if (fallbackIsUnconstrained) pass('later fallback invocations do not repeat the constrained schema retry');
  else fail('fallback invocations should omit --output-schema', JSON.stringify(fallbacks));
}

function checkNoPlanArtifact(planPath: string): void {
  if (fs.existsSync(planPath)) {
    fail('unexpected plan artifact exists after failure', planPath);
  } else {
    pass('no plan artifact was written');
  }
}

function checkBuildExists(): void {
  if (fs.existsSync(distMainPath)) return;
  fail('dist/main.js must exist before running this smoke test', 'Run `yarn build` first.');
  process.exit(1);
}

function runChecks(paths: Paths): void {
  const { result, invocations } = runScenario(paths);
  const output = `${result.stdout}\n${result.stderr}`;
  checkCommandExitsNonZero(result, output);
  checkStallDiagnostic(output);
  checkStallNotMaskedAsParseFailure(output);
  checkSchemaRepairBoundary(invocations);
  checkNoPlanArtifact(paths.planPath);
}

async function main(): Promise<void> {
  checkBuildExists();
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-codex-repair-pass-stall-'));
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
