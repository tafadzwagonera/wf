import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createReporter, summarise } from './support/reporter';

type SpawnResult = {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: Error;
};

type Paths = {
  repoDir: string;
  binDir: string;
  wfHome: string;
  homeDir: string;
  invocationLogPath: string;
  artifactDir: string;
  outputPath: string;
};

type ScenarioData = {
  result: SpawnResult;
  output: string;
  invocations: string[][];
  outputPath: string;
  artifactDir: string;
};

const projectRoot = path.resolve(__dirname, '../..');
const distMainPath = path.join(projectRoot, 'dist', 'main.js');
const outputName = 'sonar-findings.txt';

const { counts, pass, fail } = createReporter();

const run = (command: string, args: string[], cwd: string, env?: NodeJS.ProcessEnv): SpawnResult => {
  const result = spawnSync(command, args, {
    cwd,
    env,
    encoding: 'utf-8',
    maxBuffer: 1024 * 1024 * 10,
  });
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    error: result.error,
  };
};

const writeExecutable = (filePath: string, content: string): void => {
  fs.writeFileSync(filePath, content, 'utf-8');
  fs.chmodSync(filePath, 0o755);
};

const initRepo = (repoDir: string): void => {
  run('git', ['init', '-q'], repoDir);
  run('git', ['config', 'user.email', 'test@example.com'], repoDir);
  run('git', ['config', 'user.name', 'Test'], repoDir);
  fs.writeFileSync(path.join(repoDir, 'wf.config.js'), [
    'module.exports = {',
    "  ai: [{ provider: 'openai', model: 'gpt-5.4', default: true, apiKey: 'k' }],",
    "  stages: { review: { provider: 'openai', backend: 'standard', sonar: false } },",
    '};',
    '',
  ].join('\n'));
  fs.writeFileSync(path.join(repoDir, 'app.ts'), 'export const value = 1;\n');
  run('git', ['add', 'app.ts', 'wf.config.js'], repoDir);
};

function buildFakeSonarScript(invocationLogPath: string): string {
  return [
    '#!/usr/bin/env node',
    "const fs = require('fs');",
    'const args = process.argv.slice(2);',
    `fs.appendFileSync(${JSON.stringify(invocationLogPath)}, JSON.stringify(args) + '\\n');`,
    "if (args[0] === 'analyze' && args[1] === 'secrets') { console.log('secrets clean'); process.exit(0); }",
    "if (args[0] === 'analyze') { console.log('Rule hit from fake sonar'); process.exit(51); }",
    "console.error('unexpected sonar args: ' + JSON.stringify(args));",
    'process.exit(2);',
    '',
  ].join('\n');
}

const createFakeSonar = (binDir: string, invocationLogPath: string): void => {
  writeExecutable(path.join(binDir, 'sonar'), buildFakeSonarScript(invocationLogPath));
};

const record = (condition: boolean, message: string, detail?: string): void => {
  if (condition) pass(message);
  else fail(message, detail);
};

const recordAbsentPath = (filePath: string, message: string): void => {
  if (fs.existsSync(filePath)) fail(message, filePath);
  else pass(message);
};

const recordOutputExcludes = (output: string, fragment: string, message: string): void => {
  if (output.includes(fragment)) fail(message, output);
  else pass(message);
};

const readInvocationLog = (invocationLogPath: string): string[][] =>
  (fs.existsSync(invocationLogPath) ? fs.readFileSync(invocationLogPath, 'utf-8') : '')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line) as string[]);

function buildPaths(tempRoot: string): Paths {
  const repoDir = path.join(tempRoot, 'consumer-app');
  const binDir = path.join(tempRoot, 'bin');
  const wfHome = path.join(tempRoot, 'wf-home');
  const homeDir = path.join(tempRoot, 'home');
  const invocationLogPath = path.join(tempRoot, 'sonar-invocations.log');
  const artifactDir = path.join(wfHome, path.basename(repoDir));
  const outputPath = path.join(artifactDir, outputName);
  return { repoDir, binDir, wfHome, homeDir, invocationLogPath, artifactDir, outputPath };
}

function setupFixtures(paths: Paths): void {
  fs.mkdirSync(paths.repoDir, { recursive: true });
  fs.mkdirSync(paths.binDir, { recursive: true });
  initRepo(paths.repoDir);
  createFakeSonar(paths.binDir, paths.invocationLogPath);
}

function buildEnv(paths: Paths): NodeJS.ProcessEnv {
  return { ...process.env, PATH: paths.binDir + path.delimiter + (process.env.PATH ?? ''), WF_HOME: paths.wfHome, HOME: paths.homeDir, NO_COLOR: '1', CI: '1' };
}

function runScenario(paths: Paths): ScenarioData {
  const result = run('node', [distMainPath, 'issue:review', '--sonar-only', '-o', outputName, '--silent'], paths.repoDir, buildEnv(paths));
  const output = result.stdout + result.stderr;
  const invocations = readInvocationLog(paths.invocationLogPath);
  return { result, output, invocations, outputPath: paths.outputPath, artifactDir: paths.artifactDir };
}

function runChecks(data: ScenarioData): void {
  record(fs.existsSync(distMainPath), 'built CLI entrypoint exists', distMainPath);
  recordAbsentPath(data.artifactDir, 'repo-scoped artifact directory starts absent');
  record(data.result.error === undefined, 'built CLI process spawned', data.result.error?.message);
  record(data.result.status === 0, 'command exits 0 when fake sonar reports findings', data.output);
  record(fs.existsSync(data.outputPath), 'sonar-only filename output is written under the repo-scoped artifact directory', data.outputPath);
  record(fs.existsSync(data.outputPath) && fs.readFileSync(data.outputPath, 'utf-8').includes('Rule hit from fake sonar'), 'output file contains fake sonar findings text');
  record(data.output.includes('Rule hit from fake sonar'), 'silent stdout includes raw findings for piping', data.output);
  record(data.output.includes(data.outputPath), 'silent stdout includes saved output path', data.output);
  record(data.invocations.some(args => args[0] === 'analyze' && args[1] === 'secrets'), 'fake sonar received the secrets scan invocation', JSON.stringify(data.invocations));
  record(data.invocations.some(args => args[0] === 'analyze' && args.includes('--staged')), 'fake sonar received the staged analyze invocation from the sonar-only force path', JSON.stringify(data.invocations));
  recordOutputExcludes(data.output, 'Analyzing changes with AI', 'sonar-only output does not include AI review progress');
  recordAbsentPath(path.join(data.artifactDir, 'review.md'), 'sonar-only run does not create a generic review artifact');
}

async function main(): Promise<void> {
  console.log('Manual smoke: issue:review --sonar-only live CLI output\n');
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'issue-review-sonar-only-'));
  try {
    const paths = buildPaths(tempRoot);
    setupFixtures(paths);
    runChecks(runScenario(paths));
  } catch (error) {
    fail('sonar-only live CLI smoke completed', error instanceof Error ? error.message : String(error));
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
  summarise(counts);
}

main().catch(error => {
  console.error(`\nManual smoke test failed: ${error.message}`);
  process.exit(1);
});
