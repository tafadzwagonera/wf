/**
 * Manual smoke test: Claude CLI plan schema-miss repairs in-session via --resume
 *
 * Run: nr test:manual issue-plan-claude-schema-repair-live.smoke.ts
 *
 * Scenario: Claude's CLI pass loop now validates JSON in-loop; a
 * schema-invalid pass 1 result must trigger exactly one resumed repair pass
 * carrying the stage-agnostic `cliRetryPrompt` — not a fresh, full-context
 * restart, and not a silent hand-off to the completions repair on the first
 * miss.
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
 *   2. The fake `claude` binary is invoked exactly twice.
 *   3. The second invocation's args include `--resume sess-1` matching the
 *      `session_id` from pass 1's stream-json output.
 *   4. The second invocation's piped prompt contains "JSON schema provided
 *      in the original instructions" (the reworded, stage-agnostic
 *      `cliRetryPrompt` — not the old "resolution plan schema" wording).
 *   5. The resulting plan's `summary` matches pass 2's payload, confirming
 *      the repaired content — not pass 1's invalid content — was used.
 *
 * Wire up: write a temp `wf.config.js`, `source.md`, and a fake `claude`
 * executable that reads the prompt from stdin and, on its first invocation,
 * emits schema-invalid plan JSON with `session_id: "sess-1"`; on
 * invocations carrying `--resume sess-1`, emits valid plan JSON instead.
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

const schemaInvalidPlanJson = JSON.stringify({ action: 'fix', summary: 'bad' });

const validPlanJson = JSON.stringify({
  action: 'fix',
  summary: 'Repaired via resume',
  steps: ['Step 1'],
  estimatedComplexity: 'low',
  affectedRepositories: ['repo'],
});

const buildFakeClaudeScript = (invocationLogPath: string): string => `#!/usr/bin/env node
const fs = require('fs');
const args = process.argv.slice(2);

fs.appendFileSync(${JSON.stringify(invocationLogPath)}, JSON.stringify(args) + '\\n');

const resumeIndex = args.indexOf('--resume');
const isResume = resumeIndex !== -1 && args[resumeIndex + 1] === 'sess-1';

let input = '';
process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('end', () => {
  fs.appendFileSync(${JSON.stringify(invocationLogPath)}.replace(/\\.log$/, '.prompts.log'), input + '\\n---\\n');

  const result = isResume ? ${JSON.stringify(validPlanJson)} : ${JSON.stringify(schemaInvalidPlanJson)};
  console.log(JSON.stringify({ type: 'result', subtype: 'success', result, session_id: 'sess-1' }));
});
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

type Paths = {
  homeDir: string;
  repoDir: string;
  binDir: string;
  sourcePath: string;
  configPath: string;
  claudeScriptPath: string;
  invocationLogPath: string;
  promptsLogPath: string;
  planPath: string;
};

type ScenarioResult = {
  result: SpawnResult;
  invocations: string[][];
  prompts: string[];
};

type BasicPaths = Omit<Paths, 'planPath'>;

function buildBasicPaths(tempRoot: string): BasicPaths {
  const homeDir = path.join(tempRoot, 'home');
  const repoDir = path.join(tempRoot, 'repo');
  const binDir = path.join(tempRoot, 'bin');
  return {
    homeDir,
    repoDir,
    binDir,
    sourcePath: path.join(repoDir, 'source.md'),
    configPath: path.join(repoDir, 'wf.config.js'),
    claudeScriptPath: path.join(binDir, 'claude'),
    invocationLogPath: path.join(tempRoot, 'invocations.log'),
    promptsLogPath: path.join(tempRoot, 'invocations.prompts.log'),
  };
}

function buildComputedPlanPath(homeDir: string, repoDir: string, sourcePath: string): string {
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
  const basic = buildBasicPaths(tempRoot);
  return {
    ...basic,
    planPath: buildComputedPlanPath(basic.homeDir, basic.repoDir, basic.sourcePath),
  };
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

function setupWorkspace(opts: Omit<Paths, 'planPath' | 'promptsLogPath'>): NodeJS.ProcessEnv {
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

function runScenario(paths: Paths): ScenarioResult {
  const env = setupWorkspace(paths);
  const result = runCommand(paths.repoDir, paths.sourcePath, env);
  const invocations = readInvocations(paths.invocationLogPath);
  const prompts = readPrompts(paths.promptsLogPath);
  return { result, invocations, prompts };
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

function checkTwoInvocations(invocations: string[][]): void {
  if (invocations.length === 2) {
    pass('fake claude binary was invoked exactly twice');
  } else {
    fail('expected exactly 2 claude invocations', `got ${invocations.length}: ${JSON.stringify(invocations)}`);
  }
}

function checkSecondInvocationResumes(invocations: string[][]): void {
  const secondArgs = invocations[1] ?? [];
  if (secondArgs.includes('--resume') && secondArgs.includes('sess-1')) {
    pass('second invocation resumes session sess-1');
  } else {
    fail('second invocation should carry --resume sess-1', JSON.stringify(secondArgs));
  }
}

function checkSecondPromptRetryWording(prompts: string[]): void {
  const secondPrompt = prompts[1] ?? '';
  if (secondPrompt.includes('JSON schema provided in the original instructions')) {
    pass('second invocation prompt uses the stage-agnostic cliRetryPrompt wording');
  } else {
    fail('second invocation prompt should use the stage-agnostic retry wording', secondPrompt.slice(0, 500));
  }
}

function checkArtifactSummary(planPath: string): void {
  if (fs.existsSync(planPath)) {
    const artifact = JSON.parse(fs.readFileSync(planPath, 'utf-8'));
    if (artifact.summary === 'Repaired via resume') {
      pass('plan artifact reflects the repaired (pass 2) content');
    } else {
      fail('plan artifact should reflect repaired content', JSON.stringify(artifact.summary));
    }
    return;
  }
  fail('plan artifact should exist before content is checked', planPath);
}

function checkBuildExists(): void {
  if (fs.existsSync(distMainPath)) return;
  {
    fail('dist/main.js must exist before running this smoke test', 'Run `yarn build` first.');
    process.exit(1);
  }
}

function runChecks(paths: Paths): void {
  const { result, invocations, prompts } = runScenario(paths);
  const output = `${result.stdout}\n${result.stderr}`;
  checkCommandExitsZero(result, output);
  checkPlanArtifactWritten(paths.planPath, output);
  checkTwoInvocations(invocations);
  checkSecondInvocationResumes(invocations);
  checkSecondPromptRetryWording(prompts);
  checkArtifactSummary(paths.planPath);
}

async function main(): Promise<void> {
  checkBuildExists();
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-claude-schema-repair-'));
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
