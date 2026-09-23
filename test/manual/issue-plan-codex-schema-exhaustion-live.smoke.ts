/**
 * Manual smoke test: Codex plan schema-retry exhaustion gives Codex its full
 * repair opportunity before any downstream fallback, and fails cleanly
 *
 * Run: nr test:manual issue-plan-codex-schema-exhaustion-live.smoke.ts
 *
 * Scenario: When BOTH Codex passes emit schema-invalid JSON, the schema-defense
 * loop must give Codex its full 2-pass repair opportunity — carrying the
 * injected JSON Schema on pass 1 and the corrective Zod diagnostic on pass 2 —
 * before anything falls through to the last-resort completions repair. (That
 * repair path itself is untouched, backend-blind, platform-routed behavior —
 * out of scope for this fix — so the config here omits an API key to keep the
 * fallback's own failure fast and network-free rather than asserting on
 * whichever provider/network error it happens to surface.)
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
 *   2. The fake Codex binary is invoked four times: two constrained Codex
 *      passes followed by two downstream fallback passes.
 *   3. The first invocation's prompt carries the injected JSON Schema.
 *   4. The second invocation resumes the pass-1 thread id and carries the
 *      `Field: 'steps'` corrective diagnostic — proving the retry loop, not
 *      an immediate bail-out, ran before any fallback.
 *   5. No plan artifact is written.
 *   6. The final output is a clean, categorized configuration/provider error
 *      (not a raw stack trace, not a stall/"workload not decreasing" message,
 *      not a 429).
 *
 * Wire up: same temp-repo/fake-binary harness as the schema-repair-live
 * test, but the fake `codex` script always emits the phase-nested
 * (schema-invalid) payload regardless of invocation count, and the config
 * has no `apiKey` so the downstream repair fails fast on a configuration
 * error instead of making a real network call.
 * Teardown: remove the temp repo, fake executables, and isolated `HOME` tree.
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

const buildInlineInputHandlerLines = (logPath: string, shape: string): string[] => [
  'let input = \'\';',
  'process.stdin.on(\'data\', chunk => { input += chunk; });',
  'process.stdin.on(\'end\', () => {',
  `  fs.appendFileSync(${logPath}.replace(/\\.log$/, '.prompts.log'), input + '\\n---\\n');`,
  '  const isResume = args.includes(\'resume\');',
  '  if (!isResume) {',
  `    console.log(JSON.stringify({ type: 'thread.started', thread_id: 'tid-2' }));`,
  '  }',
  `  console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: ${shape} } }));`,
  '});',
];

const buildInlineInputHandler = (invocationLogPath: string): string => {
  const logPath = JSON.stringify(invocationLogPath);
  const shape = JSON.stringify(incidentShapeJson);
  return buildInlineInputHandlerLines(logPath, shape).join('\n');
};

const buildFakeCodexScript = (invocationLogPath: string): string => `#!/usr/bin/env node
const fs = require('fs');
const args = process.argv.slice(2);

if (args[0] === '--version') {
  console.log('codex-cli 0.142.5');
  process.exit(0);
}

fs.appendFileSync(${JSON.stringify(invocationLogPath)}, JSON.stringify(args) + '\\n');

${buildInlineInputHandler(invocationLogPath)}
`;

function readInvocations(logPath: string): string[][] {
  return fs.existsSync(logPath)
    ? fs.readFileSync(logPath, 'utf-8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
    : [];
}

function readPrompts(promptsLogPath: string): string[] {
  return fs.existsSync(promptsLogPath)
    ? fs.readFileSync(promptsLogPath, 'utf-8').split('\n---\n').filter(Boolean)
    : [];
}

type BuildPathsResult = {
  homeDir: string;
  repoDir: string;
  binDir: string;
  sourcePath: string;
  configPath: string;
  codexScriptPath: string;
  codexAliasPath: string;
  invocationLogPath: string;
  promptsLogPath: string;
  planPath: string;
};

function buildPathsParts(tempRoot: string, repoDir: string, binDir: string, homeDir: string, planFilename: string): Omit<BuildPathsResult, 'homeDir' | 'repoDir' | 'binDir' | 'sourcePath'> {
  return {
    configPath: path.join(repoDir, 'wf.config.js'),
    codexScriptPath: path.join(binDir, 'codex'),
    codexAliasPath: path.join(binDir, 'Codex'),
    invocationLogPath: path.join(tempRoot, 'invocations.log'),
    promptsLogPath: path.join(tempRoot, 'invocations.prompts.log'),
    planPath: path.join(homeDir, '.wf', path.basename(repoDir), planFilename),
  };
}

function buildPaths(tempRoot: string): BuildPathsResult {
  const homeDir = path.join(tempRoot, 'home');
  const repoDir = path.join(tempRoot, 'repo');
  const binDir = path.join(tempRoot, 'bin');
  const sourcePath = path.join(repoDir, 'source.md');
  const repoName = path.basename(repoDir);
  const planFilename = buildPlanArtifactFilename({
    hash: hashPlanArtifactSources([path.basename(sourcePath, '.md')]),
    action: 'fix',
    format: 'json',
  });
  const parts = buildPathsParts(tempRoot, repoDir, binDir, homeDir, planFilename);
  return { homeDir, repoDir, binDir, sourcePath, ...parts };
}

const CONFIG_CONTENT = [
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

function writeConfigFile(configPath: string): void {
  fs.writeFileSync(configPath, CONFIG_CONTENT, 'utf-8');
}

type SetupWorkspaceOpts = {
  repoDir: string;
  binDir: string;
  homeDir: string;
  configPath: string;
  sourcePath: string;
  codexScriptPath: string;
  codexAliasPath: string;
  invocationLogPath: string;
};

const setupDirectories = (opts: SetupWorkspaceOpts): void => {
  fs.mkdirSync(opts.repoDir, { recursive: true });
  fs.mkdirSync(opts.binDir, { recursive: true });
  fs.mkdirSync(opts.homeDir, { recursive: true });
  fs.mkdirSync(path.join(opts.homeDir, '.wf', 'logs'), { recursive: true });
  fs.mkdirSync(path.join(opts.homeDir, '.wf', 'state'), { recursive: true });
};

function writeSourceFile(sourcePath: string): void {
  fs.writeFileSync(
    sourcePath,
    ['# Smoke source', '', 'This file forces the real plan stage to invoke the CLI backend.', ''].join('\n'),
    'utf-8',
  );
}

function buildProcessEnv(homeDir: string, binDir: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    HOME: homeDir,
    PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ''}`,
    WF_SKIP_CLI_VERSION_CHECK: '1',
  };
}

function setupWorkspace(opts: SetupWorkspaceOpts): NodeJS.ProcessEnv {
  setupDirectories(opts);
  writeConfigFile(opts.configPath);
  writeSourceFile(opts.sourcePath);
  writeExecutable(opts.codexAliasPath, ['#!/bin/sh', 'exit 0', ''].join('\n'));
  writeExecutable(opts.codexScriptPath, buildFakeCodexScript(opts.invocationLogPath));
  return buildProcessEnv(opts.homeDir, opts.binDir);
}

type RunScenarioResult = {
  result: SpawnResult;
  invocations: string[][];
  prompts: string[];
};

function runScenario(paths: ReturnType<typeof buildPaths>): RunScenarioResult {
  const env = setupWorkspace(paths);
  const result = runCommand(paths.repoDir, paths.sourcePath, env);
  const invocations = readInvocations(paths.invocationLogPath);
  const prompts = readPrompts(paths.promptsLogPath);
  return { result, invocations, prompts };
}

function checkCommandExitsNonZero(result: SpawnResult, output: string): void {
  if (result.status === 0) {
    fail('command should exit non-zero when both passes are schema-invalid', output);
  } else {
    pass('command exits non-zero');
  }
}

function checkBoundedInvocations(invocations: string[][]): void {
  if (invocations.length === 4) {
    pass('fake Codex binary made two bounded schema passes and two fallback passes');
  } else {
    fail('expected exactly 4 Codex invocations', `got ${invocations.length}: ${JSON.stringify(invocations)}`);
  }
}

function checkFirstPromptCarriesSchema(prompts: string[]): void {
  const firstPrompt = prompts[0] ?? '';
  if (firstPrompt.includes('Output contract') && firstPrompt.includes('"stepIndices"')) {
    pass('first invocation prompt carries the injected JSON Schema');
  } else {
    fail('first invocation prompt should contain the JSON Schema', firstPrompt.slice(0, 500));
  }
}

function checkSecondInvocationResumedWithDiagnostic(invocations: string[][], prompts: string[]): void {
  const secondArgs = invocations[1] ?? [];
  const secondPrompt = prompts[1] ?? '';
  if (secondArgs.includes('resume') && secondArgs.includes('tid-2') && secondPrompt.includes("Field: 'steps'")) {
    pass('second invocation resumed pass 1 and carried the corrective Zod diagnostic');
  } else {
    fail('second invocation should resume tid-2 with the corrective diagnostic', `args: ${JSON.stringify(secondArgs)}\nprompt: ${secondPrompt.slice(0, 500)}`);
  }
}

function checkFallbackInvocationsAreUnconstrained(invocations: string[][]): void {
  const fallbackInvocations = invocations.slice(2);
  const schemaFlags = fallbackInvocations.flatMap(args => args.filter(arg => arg === '--output-schema'));
  if (fallbackInvocations.length === 2 && schemaFlags.length === 0) {
    pass('downstream fallback runs without repeating the constrained schema retry');
  } else {
    fail('downstream fallback should be bounded and unconstrained', JSON.stringify(fallbackInvocations));
  }
}

function checkNoPlanArtifact(planPath: string): void {
  if (fs.existsSync(planPath)) {
    fail('unexpected plan artifact exists after failure', planPath);
  } else {
    pass('no plan artifact was written');
  }
}

function checkNoStallOr429(output: string): void {
  if (/\b429\b/.test(output) || output.includes('workload not decreasing')) {
    fail('final output unexpectedly looks like a 429 or stall failure', output);
  } else {
    pass('final output is not a 429 or a stall/"workload not decreasing" message');
  }
}

function checkCleanConfigurationError(output: string): void {
  if (output.includes('Failed to parse AI response as JSON')) {
    pass('the last-resort fallback fails with a clean parse error, not a crash');
  } else {
    fail('expected a clean parse error from the fallback path', output);
  }
}

function checkBuildExists(): void {
  if (fs.existsSync(distMainPath)) return;
  {
    fail('dist/main.js must exist before running this smoke test', 'Run `yarn build` first.');
    process.exit(1);
  }
}

function checkInvocationValidations(invocations: string[][], prompts: string[]): void {
  checkBoundedInvocations(invocations);
  checkFirstPromptCarriesSchema(prompts);
  checkSecondInvocationResumedWithDiagnostic(invocations, prompts);
  checkFallbackInvocationsAreUnconstrained(invocations);
}

function checkOutputValidations(result: SpawnResult, planPath: string): void {
  const output = `${result.stdout}\n${result.stderr}`;
  checkCommandExitsNonZero(result, output);
  checkNoPlanArtifact(planPath);
  checkNoStallOr429(output);
  checkCleanConfigurationError(output);
}

const runAllValidations = (
  result: SpawnResult,
  invocations: string[][],
  prompts: string[],
  planPath: string,
): void => {
  checkInvocationValidations(invocations, prompts);
  checkOutputValidations(result, planPath);
};

async function main(): Promise<void> {
  checkBuildExists();
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-codex-schema-exhaustion-'));
  const paths = buildPaths(tempRoot);
  try {
    const { result, invocations, prompts } = runScenario(paths);
    runAllValidations(result, invocations, prompts, paths.planPath);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
  summarise(counts);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
