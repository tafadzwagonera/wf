/**
 * Manual smoke test: issue:review --output subdirectory paths write under the repo artifact namespace
 *
 * Run: nr test:manual issue-review-output-artifact-subdir.smoke.ts
 *
 * Scenario: The user passes a relative output path with a directory
 * component, such as `--output reports/review.md`. wf must write the review
 * artifact under `$WF_HOME/<repo>/reports/review.md`, not under
 * `<cwd>/reports/review.md`.
 *
 * Config under test:
 *   ai: [
 *     { provider: 'anthropic', model: 'claude-sonnet-4-6', default: true, apiKey: 'k' },
 *   ]
 *   stages: {
 *     review: { provider: 'anthropic', backend: 'cli', model: 'claude-sonnet-4-6' }
 *   }
 *
 * Verify:
 *   1. Running `node dist/main.js issue:review -r <repo> --output
 *      reports/review.md -s` exits 0 against a temp repo with a real diff.
 *   2. $WF_HOME/<repo-basename>/reports/review.md exists after the command.
 *   3. The written file contains the fake review summary.
 *   4. <repo>/reports/review.md does not exist.
 *   5. Re-running with `--output review.md` still writes
 *      $WF_HOME/<repo-basename>/review.md, preserving filename-only behavior.
 *   6. Re-running with an absolute output path writes exactly that absolute
 *      path.
 *
 * Wire up: build the project first, create a temp git repo with one
 * committed file and one uncommitted edit, write wf.config.js for Claude CLI
 * review, and place a fake `claude` executable ahead of PATH. The fake
 * claude should return a valid CodeReview JSON result and a plain epilogue
 * for any follow-up call. Run the compiled CLI via node dist/main.js for each
 * output mode, using an isolated absolute WF_HOME.
 * Teardown: remove the temp repo, absolute output temp file, fake bin
 * directory, isolated WF_HOME, and invocation logs.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { createReporter, summarise } from './support/reporter';

type SpawnResult = {
  status: number | null;
  stdout: string;
  stderr: string;
};

type Paths = {
  wfHomeDir: string;
  repoDir: string;
  binDir: string;
  configPath: string;
  claudeScriptPath: string;
  trackedFilePath: string;
  repoBasename: string;
  absoluteOutputPath: string;
};

const projectRoot = path.resolve(__dirname, '../..');
const distMainPath = path.join(projectRoot, 'dist', 'main.js');

const { counts, pass, fail } = createReporter();

const REVIEW_SUMMARY = 'Fake review summary: no blocking issues found.';

const writeExecutable = (filePath: string, content: string): void => {
  fs.writeFileSync(filePath, content, 'utf-8');
  fs.chmodSync(filePath, 0o755);
};

const validReviewJson = JSON.stringify({
  summary: REVIEW_SUMMARY,
  issues: [],
  suggestions: [],
  approved: true,
});

const buildFakeClaudeScript = (): string => `#!/usr/bin/env node
let input = '';
process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('end', () => {
  console.log(JSON.stringify({ type: 'result', subtype: 'success', result: ${JSON.stringify(validReviewJson)}, session_id: 'sess-output-1' }));
});
`;

const runReview = (repoDir: string, env: NodeJS.ProcessEnv, outputArg: string): SpawnResult => {
  const result = spawnSync(
    'node',
    [distMainPath, 'issue:review', '-r', repoDir, '--output', outputArg, '-s'],
    { cwd: repoDir, env, encoding: 'utf-8', maxBuffer: 1024 * 1024 * 10 }
  );
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
};

function buildPaths(tempRoot: string): Paths {
  const wfHomeDir = path.join(tempRoot, 'wfhome');
  const repoDir = path.join(tempRoot, 'repo');
  const binDir = path.join(tempRoot, 'bin');
  return {
    wfHomeDir,
    repoDir,
    binDir,
    configPath: path.join(repoDir, 'wf.config.js'),
    claudeScriptPath: path.join(binDir, 'claude'),
    trackedFilePath: path.join(repoDir, 'src.ts'),
    repoBasename: path.basename(repoDir),
    absoluteOutputPath: path.join(tempRoot, 'absolute-review.md'),
  };
}

function buildConfigContent(): string {
  return [
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
}

function setupGitRepo(repoDir: string, trackedFilePath: string): void {
  const gitEnv = { ...process.env, GIT_AUTHOR_NAME: 'wf', GIT_AUTHOR_EMAIL: 'wf@example.com', GIT_COMMITTER_NAME: 'wf', GIT_COMMITTER_EMAIL: 'wf@example.com' };
  execFileSync('git', ['init', '-q'], { cwd: repoDir, env: gitEnv });
  fs.writeFileSync(trackedFilePath, 'line 1\nline 2\n', 'utf-8');
  execFileSync('git', ['add', 'src.ts'], { cwd: repoDir, env: gitEnv });
  execFileSync('git', ['commit', '-q', '-m', 'initial'], { cwd: repoDir, env: gitEnv });
  fs.writeFileSync(trackedFilePath, 'line 1\nline 2\nline 3 added\n', 'utf-8');
}

function setupFixtures(paths: Paths): void {
  fs.mkdirSync(paths.repoDir, { recursive: true });
  fs.mkdirSync(paths.binDir, { recursive: true });
  fs.mkdirSync(path.join(paths.wfHomeDir, 'logs'), { recursive: true });
  fs.mkdirSync(path.join(paths.wfHomeDir, 'state'), { recursive: true });
  setupGitRepo(paths.repoDir, paths.trackedFilePath);
  fs.writeFileSync(paths.configPath, buildConfigContent(), 'utf-8');
  writeExecutable(paths.claudeScriptPath, buildFakeClaudeScript());
}

function buildEnv(paths: Paths): NodeJS.ProcessEnv {
  return { ...process.env, HOME: os.homedir(), WF_HOME: paths.wfHomeDir, PATH: `${paths.binDir}${path.delimiter}${process.env.PATH ?? ''}`, WF_SKIP_CLI_VERSION_CHECK: '1' };
}

function checkDistExists(): void {
  if (!fs.existsSync(distMainPath)) {
    fail('dist/main.js must exist before running this smoke test', 'Run `yarn build` first.');
    process.exit(1);
  }
}

function checkNestedOutput(paths: Paths, env: NodeJS.ProcessEnv): void {
  const result = runReview(paths.repoDir, env, 'reports/review.md');
  const output = `${result.stdout}\n${result.stderr}`;
  const artifactPath = path.join(paths.wfHomeDir, paths.repoBasename, 'reports', 'review.md');
  const cwdNestedPath = path.join(paths.repoDir, 'reports', 'review.md');
  if (result.status === 0) pass('nested-output run exits 0');
  else fail('nested-output run should exit 0', output);
  if (fs.existsSync(artifactPath)) pass('$WF_HOME/<repo>/reports/review.md exists');
  else fail('$WF_HOME/<repo>/reports/review.md should exist', `checked ${artifactPath}\noutput:\n${output}`);
  const content = fs.existsSync(artifactPath) ? fs.readFileSync(artifactPath, 'utf-8') : '';
  if (content.includes(REVIEW_SUMMARY)) pass('written file contains the fake review summary');
  else fail('written file should contain the fake review summary', content.slice(0, 500));
  if (!fs.existsSync(cwdNestedPath)) pass('<repo>/reports/review.md does not exist');
  else fail('<repo>/reports/review.md should not exist', cwdNestedPath);
}

function checkFlatOutput(paths: Paths, env: NodeJS.ProcessEnv): void {
  const result = runReview(paths.repoDir, env, 'review.md');
  const output = `${result.stdout}\n${result.stderr}`;
  const artifactPath = path.join(paths.wfHomeDir, paths.repoBasename, 'review.md');
  if (result.status === 0 && fs.existsSync(artifactPath))
    pass('filename-only output preserves $WF_HOME/<repo>/review.md behavior');
  else fail('filename-only output should still write $WF_HOME/<repo>/review.md', `checked ${artifactPath}\noutput:\n${output}`);
}

function checkAbsoluteOutput(paths: Paths, env: NodeJS.ProcessEnv): void {
  const result = runReview(paths.repoDir, env, paths.absoluteOutputPath);
  const output = `${result.stdout}\n${result.stderr}`;
  if (result.status === 0 && fs.existsSync(paths.absoluteOutputPath))
    pass('absolute output path writes exactly that absolute path');
  else fail('absolute output path should write exactly that path', `checked ${paths.absoluteOutputPath}\noutput:\n${output}`);
}

function runChecks(paths: Paths, env: NodeJS.ProcessEnv): void {
  checkNestedOutput(paths, env);
  checkFlatOutput(paths, env);
  checkAbsoluteOutput(paths, env);
}

async function main(): Promise<void> {
  checkDistExists();
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-output-artifact-subdir-'));
  try {
    const paths = buildPaths(tempRoot);
    setupFixtures(paths);
    runChecks(paths, buildEnv(paths));
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
  summarise(counts);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
