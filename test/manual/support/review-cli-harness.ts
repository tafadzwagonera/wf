import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';

export const projectRoot = path.resolve(__dirname, '../../..');
export const distMainPath = path.join(projectRoot, 'dist', 'main.js');

export type ReviewHarness = {
  tempRoot: string;
  repoDir: string;
  binDir: string;
  homeDir: string;
  promptDir: string;
  countFile: string;
};

export type ReviewRunResult = { exitCode: number | null; output: string };

const fakeClaudeSource = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const here = __dirname;
if (process.argv[2] === '--version') {
  console.log('2.1.219 (Claude Code)');
  process.exit(0);
}
const { review, countFile, promptDir } = JSON.parse(fs.readFileSync(path.join(here, 'scenario.json'), 'utf8'));
fs.appendFileSync(countFile, 'x\\n');
const n = fs.readFileSync(countFile, 'utf8').split('\\n').filter(Boolean).length;
let input = '';
process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('end', () => {
  fs.writeFileSync(path.join(promptDir, n + '.txt'), process.argv.slice(2).join('\\n') + '\\n' + input);
  console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: JSON.stringify(review), session_id: 'sess-' + n, num_turns: 1 }));
});
`;

const buildConfig = (): string => [
  'module.exports = {',
  '  ai: [',
  "    { provider: 'anthropic', model: 'claude-sonnet-4-6', default: true, apiKey: 'test-key' },",
  '  ],',
  '  stages: {',
  "    review: { provider: 'anthropic', backend: 'cli', model: 'claude-sonnet-4-6' },",
  '  },',
  '};',
  '',
].join('\n');

const createLayout = (tempRoot: string): ReviewHarness => ({
  tempRoot,
  repoDir: path.join(tempRoot, 'repo'),
  binDir: path.join(tempRoot, 'bin'),
  homeDir: path.join(tempRoot, 'home'),
  promptDir: path.join(tempRoot, 'prompts'),
  countFile: path.join(tempRoot, 'spawn-count.txt'),
});

const makeDirectories = (harness: ReviewHarness): void => {
  const dirs = [
    harness.repoDir, harness.binDir, harness.promptDir,
    path.join(harness.homeDir, '.wf', 'logs'), path.join(harness.homeDir, '.wf', 'state'),
  ];
  for (const dir of dirs) fs.mkdirSync(dir, { recursive: true });
};

const installFakeClaude = (harness: ReviewHarness, review: Record<string, unknown>): void => {
  const { countFile, promptDir } = harness;
  fs.writeFileSync(harness.countFile, '');
  fs.writeFileSync(path.join(harness.binDir, 'scenario.json'), JSON.stringify({ review, countFile, promptDir }));
  fs.writeFileSync(path.join(harness.binDir, 'claude'), fakeClaudeSource, { mode: 0o755 });
};

const runGit = (repoDir: string, args: string[]): void => {
  const result = spawnSync('git', args, { cwd: repoDir, encoding: 'utf-8' });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  }
};

const initGitRepoWithUncommittedChange = (harness: ReviewHarness): void => {
  fs.writeFileSync(path.join(harness.repoDir, 'wf.config.js'), buildConfig(), 'utf-8');
  fs.writeFileSync(path.join(harness.repoDir, 'greeter.js'), "exports.greet = () => 'hello';\n", 'utf-8');
  runGit(harness.repoDir, ['init']);
  runGit(harness.repoDir, ['config', 'user.email', 'smoke@example.com']);
  runGit(harness.repoDir, ['config', 'user.name', 'Smoke Test']);
  runGit(harness.repoDir, ['add', '.']);
  runGit(harness.repoDir, ['commit', '-m', 'base']);
  fs.writeFileSync(path.join(harness.repoDir, 'greeter.js'), "exports.greet = () => 'hello there';\n", 'utf-8');
};

export const setupReviewHarness = (prefix: string, review: Record<string, unknown>): ReviewHarness => {
  const harness = createLayout(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  makeDirectories(harness);
  installFakeClaude(harness, review);
  initGitRepoWithUncommittedChange(harness);
  return harness;
};

export const runReviewCli = (harness: ReviewHarness, args: string[], timeoutMs = 90_000): ReviewRunResult => {
  const env = {
    ...process.env,
    HOME: harness.homeDir,
    PATH: `${harness.binDir}${path.delimiter}${process.env['PATH'] ?? ''}`,
    WF_SKIP_CLI_VERSION_CHECK: '1',
  };
  const result = spawnSync('node', [distMainPath, 'issue:review', ...args], {
    cwd: harness.repoDir, env, encoding: 'utf-8', maxBuffer: 1024 * 1024 * 10, timeout: timeoutMs,
  });
  return { exitCode: result.status, output: `${result.stdout ?? ''}\n${result.stderr ?? ''}` };
};

export const runReview = (harness: ReviewHarness, timeoutMs = 90_000): ReviewRunResult =>
  runReviewCli(harness, ['--silent', '--skip-verification'], timeoutMs);

export const countReviewSpawns = (harness: ReviewHarness): number =>
  fs.readFileSync(harness.countFile, 'utf-8').split('\n').filter(Boolean).length;

export const readReviewPrompt = (harness: ReviewHarness, callNumber: number): string => {
  const promptPath = path.join(harness.promptDir, `${callNumber}.txt`);
  return fs.existsSync(promptPath) ? fs.readFileSync(promptPath, 'utf-8') : '';
};

export const readAllowedTools = (recordedCall: string): string => {
  const lines = recordedCall.split('\n');
  const flagIndex = lines.indexOf('--allowedTools');
  return flagIndex >= 0 ? lines[flagIndex + 1] ?? '' : '';
};

export const cleanupReviewHarness = (harness: ReviewHarness): void => {
  fs.rmSync(harness.tempRoot, { recursive: true, force: true });
};
