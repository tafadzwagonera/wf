/**
 * Manual smoke test: issue:review derives the verdict from risk-adjusted severity
 *
 * Run: nr test:manual issue-review-risk-adjusted-verdict.smoke
 *
 * Scenario: a user reviews a real uncommitted edit in a temp git repo through
 * the compiled CLI with JSON output (`-f json -o <abs path>`). The model (a
 * deterministic fake `claude` binary on PATH) reports an `error` issue with a
 * given `risk`, and the saved review JSON shows the verdict wf derives from
 * the risk-adjusted severity, not from the raw severity alone.
 *
 * Verifies:
 *   1. An error issue with risk 0.5 (demoted to warning) keeps the model's
 *      `approved: true`, and the saved issue round-trips `risk: 0.5`
 *   2. An error issue with risk 0.9 (still error) forces `approved: false`
 *      even though the model returned `approved: true`
 *   3. An error issue with no risk keeps blocking approval (risk defaults to 1)
 *   4. Each run exits 0 and persists a parseable review JSON artifact
 *
 * Wire up: real temp git repo with one committed file and one uncommitted
 * added line; `wf.config.js` in the repo selects the anthropic provider with
 * `backend: 'cli'`; the fake `claude` executable replays a `codeReviewSchema`
 * payload read from a per-scenario response file. HOME is isolated to a temp
 * tree so no user state is touched, and the absolute `-o` path keeps output
 * out of `~/.wf`.
 * Teardown: remove the temp root (repo, fake binary, home tree, outputs).
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
  homeDir: string;
  repoDir: string;
  binDir: string;
  configPath: string;
  claudeScriptPath: string;
  responsePath: string;
  trackedFilePath: string;
};

type Scenario = {
  name: string;
  risk: number | undefined;
  expectedApproved: boolean;
};

const projectRoot = path.resolve(__dirname, '../..');
const distMainPath = path.join(projectRoot, 'dist', 'main.js');

const scenarios: Scenario[] = [
  { name: 'error demoted by risk 0.5 stays approved', risk: 0.5, expectedApproved: true },
  { name: 'error retained at risk 0.9 blocks approval', risk: 0.9, expectedApproved: false },
  { name: 'error without risk blocks approval', risk: undefined, expectedApproved: false },
];

const { counts, pass, fail } = createReporter();

const writeExecutable = (filePath: string, content: string): void => {
  fs.writeFileSync(filePath, content, 'utf-8');
  fs.chmodSync(filePath, 0o755);
};

const buildReviewJson = (risk: number | undefined): string =>
  JSON.stringify({
    summary: 'One risky-looking issue found',
    issues: [
      {
        file: 'src.ts',
        line: 3,
        message: 'Unguarded parse on the added line',
        severity: 'error',
        ...(risk === undefined ? {} : { risk }),
      },
    ],
    suggestions: [],
    approved: true,
  });

const buildFakeClaudeScript = (responsePath: string): string => `#!/usr/bin/env node
const fs = require('fs');
let input = '';
process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('end', () => {
  const result = fs.readFileSync(${JSON.stringify(responsePath)}, 'utf-8');
  console.log(JSON.stringify({ type: 'result', subtype: 'success', result, session_id: 'sess-risk-1' }));
});
`;

function buildPaths(tempRoot: string): Paths {
  const homeDir = path.join(tempRoot, 'home');
  const repoDir = path.join(tempRoot, 'repo');
  const binDir = path.join(tempRoot, 'bin');
  return {
    homeDir,
    repoDir,
    binDir,
    configPath: path.join(repoDir, 'wf.config.js'),
    claudeScriptPath: path.join(binDir, 'claude'),
    responsePath: path.join(tempRoot, 'review-response.json'),
    trackedFilePath: path.join(repoDir, 'src.ts'),
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

function setupGitRepo(repoDir: string, trackedFilePath: string, homeDir: string): void {
  const gitEnv = {
    ...process.env,
    HOME: homeDir,
    GIT_AUTHOR_NAME: 'wf',
    GIT_AUTHOR_EMAIL: 'wf@example.com',
    GIT_COMMITTER_NAME: 'wf',
    GIT_COMMITTER_EMAIL: 'wf@example.com',
  };
  execFileSync('git', ['init', '-q'], { cwd: repoDir, env: gitEnv });
  fs.writeFileSync(trackedFilePath, 'line 1\nline 2\n', 'utf-8');
  execFileSync('git', ['add', 'src.ts'], { cwd: repoDir, env: gitEnv });
  execFileSync('git', ['commit', '-q', '-m', 'initial'], { cwd: repoDir, env: gitEnv });
  fs.writeFileSync(trackedFilePath, 'line 1\nline 2\nconst data = JSON.parse(input);\n', 'utf-8');
}

function setupFixtures(paths: Paths): void {
  fs.mkdirSync(paths.repoDir, { recursive: true });
  fs.mkdirSync(paths.binDir, { recursive: true });
  fs.mkdirSync(paths.homeDir, { recursive: true });
  fs.mkdirSync(path.join(paths.homeDir, '.wf', 'logs'), { recursive: true });
  fs.mkdirSync(path.join(paths.homeDir, '.wf', 'state'), { recursive: true });
  setupGitRepo(paths.repoDir, paths.trackedFilePath, paths.homeDir);
  fs.writeFileSync(paths.configPath, buildConfigContent(), 'utf-8');
  writeExecutable(paths.claudeScriptPath, buildFakeClaudeScript(paths.responsePath));
}

function buildEnv(homeDir: string, binDir: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    HOME: homeDir,
    PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ''}`,
    WF_SKIP_CLI_VERSION_CHECK: '1',
  };
}

function runCommand(cwd: string, outputPath: string, env: NodeJS.ProcessEnv): SpawnResult {
  const result = spawnSync(
    'node',
    [distMainPath, 'issue:review', '-r', cwd, '-s', '--skip-verification', '-o', outputPath, '-f', 'json'],
    { cwd, env, encoding: 'utf-8', maxBuffer: 1024 * 1024 * 10 }
  );
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

function readSavedReview(outputPath: string): { approved?: boolean; risk?: number } | null {
  if (!fs.existsSync(outputPath)) return null;
  const saved = JSON.parse(fs.readFileSync(outputPath, 'utf-8'));
  const review = Array.isArray(saved) ? saved[0]?.review : saved?.review;
  if (!review) return null;
  return { approved: review.approved, risk: review.issues?.[0]?.risk };
}

function assertSavedReview(scenario: Scenario, saved: { approved?: boolean; risk?: number }): void {
  if (saved.approved !== scenario.expectedApproved) {
    fail(`${scenario.name}: approved should be ${scenario.expectedApproved}`, JSON.stringify(saved));
    return;
  }
  if (saved.risk !== scenario.risk) {
    fail(`${scenario.name}: issue risk should round-trip as ${scenario.risk}`, JSON.stringify(saved));
    return;
  }
  pass(`${scenario.name} (approved=${saved.approved}, risk=${saved.risk})`);
}

function checkScenario(scenario: Scenario, result: SpawnResult, outputPath: string): void {
  const output = `${result.stdout}\n${result.stderr}`;
  if (result.status !== 0) {
    fail(`${scenario.name}: command should exit 0`, output);
    return;
  }
  const saved = readSavedReview(outputPath);
  if (!saved) {
    fail(`${scenario.name}: expected a parseable saved review`, `outputPath: ${outputPath}\noutput:\n${output}`);
    return;
  }
  assertSavedReview(scenario, saved);
}

function runScenario(scenario: Scenario, index: number, tempRoot: string, paths: Paths): void {
  fs.writeFileSync(paths.responsePath, buildReviewJson(scenario.risk), 'utf-8');
  const outputPath = path.join(tempRoot, `review-output-${index}.json`);
  const result = runCommand(paths.repoDir, outputPath, buildEnv(paths.homeDir, paths.binDir));
  checkScenario(scenario, result, outputPath);
}

function checkDistExists(): void {
  if (fs.existsSync(distMainPath)) return;
  fail('dist/main.js must exist before running this smoke test', 'Run `yarn build` first.');
  process.exit(1);
}

async function main(): Promise<void> {
  console.log('\nissue:review risk-adjusted verdict derivation\n');
  checkDistExists();
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-review-risk-verdict-'));
  const paths = buildPaths(tempRoot);
  try {
    setupFixtures(paths);
    for (const [index, scenario] of scenarios.entries()) {
      runScenario(scenario, index, tempRoot, paths);
    }
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
  summarise(counts);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
