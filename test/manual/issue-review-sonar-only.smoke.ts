import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createReporter } from './support/reporter';

type SpawnResult = {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: Error;
};

const projectRoot = path.resolve(__dirname, '../..');
const distMainPath = path.join(projectRoot, 'dist', 'main.js');
const outputName = 'sonar-findings.txt';

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

const createFakeSonar = (binDir: string, invocationLogPath: string): void => {
  writeExecutable(path.join(binDir, 'sonar'), [
    '#!/usr/bin/env node',
    "const fs = require('fs');",
    'const args = process.argv.slice(2);',
    `fs.appendFileSync(${JSON.stringify(invocationLogPath)}, JSON.stringify(args) + '\\n');`,
    "if (args[0] === 'analyze' && args[1] === 'secrets') {",
    "  console.log('secrets clean');",
    '  process.exit(0);',
    '}',
    "if (args[0] === 'analyze') {",
    "  console.log('Rule hit from fake sonar');",
    '  process.exit(51);',
    '}',
    "console.error('unexpected sonar args: ' + JSON.stringify(args));",
    'process.exit(2);',
    '',
  ].join('\n'));
};

const record = (
  condition: boolean,
  pass: (msg: string) => void,
  fail: (msg: string, detail?: string) => void,
  message: string,
  detail?: string
): void => {
  if (condition) pass(message);
  else fail(message, detail);
};

const recordAbsentPath = (
  filePath: string,
  pass: (msg: string) => void,
  fail: (msg: string, detail?: string) => void,
  message: string
): void => {
  if (fs.existsSync(filePath)) fail(message, filePath);
  else pass(message);
};

const recordOutputExcludes = (
  output: string,
  fragment: string,
  pass: (msg: string) => void,
  fail: (msg: string, detail?: string) => void,
  message: string
): void => {
  if (output.includes(fragment)) fail(message, output);
  else pass(message);
};

const readInvocationLog = (invocationLogPath: string): string[][] =>
  (fs.existsSync(invocationLogPath) ? fs.readFileSync(invocationLogPath, 'utf-8') : '')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line) as string[]);

async function main(): Promise<void> {
  console.log('Manual smoke: issue:review --sonar-only live CLI output\n');
  const { counts, pass, fail } = createReporter();
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'issue-review-sonar-only-'));
  const repoDir = path.join(tempRoot, 'consumer-app');
  const binDir = path.join(tempRoot, 'bin');
  const wfHome = path.join(tempRoot, 'wf-home');
  const invocationLogPath = path.join(tempRoot, 'sonar-invocations.log');
  const artifactDir = path.join(wfHome, path.basename(repoDir));
  const outputPath = path.join(artifactDir, outputName);

  try {
    fs.mkdirSync(repoDir, { recursive: true });
    fs.mkdirSync(binDir, { recursive: true });
    initRepo(repoDir);
    createFakeSonar(binDir, invocationLogPath);

    record(fs.existsSync(distMainPath), pass, fail, 'built CLI entrypoint exists', distMainPath);
    recordAbsentPath(artifactDir, pass, fail, 'repo-scoped artifact directory starts absent');

    const env = {
      ...process.env,
      PATH: binDir + path.delimiter + (process.env.PATH ?? ''),
      WF_HOME: wfHome,
      HOME: path.join(tempRoot, 'home'),
      NO_COLOR: '1',
      CI: '1',
    };
    const result = run('node', [distMainPath, 'issue:review', '--sonar-only', '-o', outputName, '--silent'], repoDir, env);
    const output = result.stdout + result.stderr;
    const invocations = readInvocationLog(invocationLogPath);

    record(result.error === undefined, pass, fail, 'built CLI process spawned', result.error?.message);
    record(result.status === 0, pass, fail, 'command exits 0 when fake sonar reports findings', output);
    record(fs.existsSync(outputPath), pass, fail, 'sonar-only filename output is written under the repo-scoped artifact directory', outputPath);
    record(
      fs.existsSync(outputPath) && fs.readFileSync(outputPath, 'utf-8').includes('Rule hit from fake sonar'),
      pass,
      fail,
      'output file contains fake sonar findings text'
    );
    record(output.includes('Rule hit from fake sonar'), pass, fail, 'silent stdout includes raw findings for piping', output);
    record(output.includes(outputPath), pass, fail, 'silent stdout includes saved output path', output);
    record(
      invocations.some(args => args[0] === 'analyze' && args[1] === 'secrets'),
      pass,
      fail,
      'fake sonar received the secrets scan invocation',
      JSON.stringify(invocations)
    );
    record(
      invocations.some(args => args[0] === 'analyze' && args.includes('--staged')),
      pass,
      fail,
      'fake sonar received the staged analyze invocation from the sonar-only force path',
      JSON.stringify(invocations)
    );
    recordOutputExcludes(output, 'Analyzing changes with AI', pass, fail, 'sonar-only output does not include AI review progress');
    recordAbsentPath(path.join(artifactDir, 'review.md'), pass, fail, 'sonar-only run does not create a generic review artifact');
  } catch (error) {
    fail('sonar-only live CLI smoke completed', error instanceof Error ? error.message : String(error));
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }

  console.log(`\n${counts.passed} passed, ${counts.failed} failed`);
  if (counts.failed > 0) process.exit(1);
}

main().catch(error => {
  console.error(`\nManual smoke test failed: ${error.message}`);
  process.exit(1);
});
