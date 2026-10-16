import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';

export const projectRoot = path.resolve(__dirname, '../../..');
export const distMainPath = path.join(projectRoot, 'dist', 'main.js');

export type PlanHarness = {
  tempRoot: string;
  repoDir: string;
  binDir: string;
  homeDir: string;
  promptDir: string;
  countFile: string;
};

export type PlanRunResult = { exitCode: number | null; output: string };

const fakeClaudeSource = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const here = __dirname;
if (process.argv[2] === '--version') {
  console.log('2.1.219 (Claude Code)');
  process.exit(0);
}
const { plan, countFile, promptDir } = JSON.parse(fs.readFileSync(path.join(here, 'scenario.json'), 'utf8'));
fs.appendFileSync(countFile, 'x\\n');
const n = fs.readFileSync(countFile, 'utf8').split('\\n').filter(Boolean).length;
let input = '';
process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('end', () => {
  fs.writeFileSync(path.join(promptDir, n + '.txt'), process.argv.slice(2).join('\\n') + '\\n' + input);
  console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: JSON.stringify(plan), session_id: 'sess-' + n, num_turns: 1 }));
});
`;

const buildConfig = (): string => [
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

const createLayout = (tempRoot: string): PlanHarness => ({
  tempRoot,
  repoDir: path.join(tempRoot, 'repo'),
  binDir: path.join(tempRoot, 'bin'),
  homeDir: path.join(tempRoot, 'home'),
  promptDir: path.join(tempRoot, 'prompts'),
  countFile: path.join(tempRoot, 'spawn-count.txt'),
});

const makeDirectories = (harness: PlanHarness): void => {
  const dirs = [
    harness.repoDir, harness.binDir, harness.promptDir,
    path.join(harness.homeDir, '.wf', 'logs'), path.join(harness.homeDir, '.wf', 'state'),
  ];
  for (const dir of dirs) fs.mkdirSync(dir, { recursive: true });
};

const installFakeClaude = (harness: PlanHarness, plan: Record<string, unknown>): void => {
  const { countFile, promptDir } = harness;
  fs.writeFileSync(harness.countFile, '');
  fs.writeFileSync(path.join(harness.binDir, 'scenario.json'), JSON.stringify({ plan, countFile, promptDir }));
  fs.writeFileSync(path.join(harness.binDir, 'claude'), fakeClaudeSource, { mode: 0o755 });
};

const writeRepoFiles = (harness: PlanHarness, files: Record<string, string>): void => {
  fs.writeFileSync(path.join(harness.repoDir, 'wf.config.js'), buildConfig(), 'utf-8');
  fs.writeFileSync(path.join(harness.repoDir, 'source.md'), '# Smoke source\n\nForces the CLI plan backend.\n', 'utf-8');
  for (const [file, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(harness.repoDir, file)), { recursive: true });
    fs.writeFileSync(path.join(harness.repoDir, file), content, 'utf-8');
  }
};

export const setupPlanHarness = (
  prefix: string, plan: Record<string, unknown>, files: Record<string, string> = {},
): PlanHarness => {
  const harness = createLayout(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  makeDirectories(harness);
  installFakeClaude(harness, plan);
  writeRepoFiles(harness, files);
  return harness;
};

export const runWfCli = (harness: PlanHarness, args: string[], timeoutMs = 90_000): PlanRunResult => {
  const env = {
    ...process.env,
    HOME: harness.homeDir,
    PATH: `${harness.binDir}${path.delimiter}${process.env['PATH'] ?? ''}`,
    WF_SKIP_CLI_VERSION_CHECK: '1',
  };
  const result = spawnSync('node', [distMainPath, ...args], {
    cwd: harness.repoDir, env, encoding: 'utf-8', maxBuffer: 1024 * 1024 * 10, timeout: timeoutMs,
  });
  return { exitCode: result.status, output: `${result.stdout ?? ''}\n${result.stderr ?? ''}` };
};

export const runPlanCli = (harness: PlanHarness, args: string[], timeoutMs = 90_000): PlanRunResult =>
  runWfCli(harness, ['issue:plan', ...args], timeoutMs);

export const runPlan = (harness: PlanHarness, timeoutMs = 90_000): PlanRunResult =>
  runPlanCli(harness, ['--action', 'fix', '--custom-plan', path.join(harness.repoDir, 'source.md'), '--silent'], timeoutMs);

export const countPlanSpawns = (harness: PlanHarness): number =>
  fs.readFileSync(harness.countFile, 'utf-8').split('\n').filter(Boolean).length;

export const readPlanPrompt = (harness: PlanHarness, callNumber: number): string => {
  const promptPath = path.join(harness.promptDir, `${callNumber}.txt`);
  return fs.existsSync(promptPath) ? fs.readFileSync(promptPath, 'utf-8') : '';
};

export const cleanupPlanHarness = (harness: PlanHarness): void => {
  fs.rmSync(harness.tempRoot, { recursive: true, force: true });
};
