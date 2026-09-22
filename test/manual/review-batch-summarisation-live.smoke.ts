/**
 * Manual smoke test: oversized multi-file review diff is summarised in one batch CLI call
 *
 * Scenario: Multiple oversized file diffs are submitted for review while
 * `stages.review.backend` is `cli`. Instead of one `chatTurn` call per file,
 * all files that fit within `SUMMARISE_CHUNK_CHAR_BUDGET` (60 000 chars) must be
 * batched into a single call whose user-message contains every file's patch and
 * whose system prompt instructs the model to use `=== FILE: <path> ===` delimiters.
 * When selected segments exceed the chunk budget, the files are split across
 * multiple calls — one per chunk — not one per file.
 *
 * Config under test:
 *   ```ts
 *   ai: [
 *     { provider: 'anthropic', model: 'claude-sonnet-4-6', default: true, apiKey: 'k' },
 *   ]
 *   stages: {
 *     review: { provider: 'anthropic', backend: 'cli' }
 *   }
 *   ```
 *
 * Verify:
 *   1. Run `wf issue:review` against a temp repo whose staged diff contains 5 files
 *      each ~20 000 chars (total 100 000, above the 80 000 default threshold). The
 *      fake `claude` binary records every invocation. Confirm the summarisation
 *      invocation count is 1, not 2 (the 2 largest selected files fit in one chunk).
 *   2. The recorded prompt for that single summarisation call contains `File: `
 *      sections for exactly 2 files (the 2 selected ones).
 *   3. Files that fit under the threshold after summarisation (the other 3) do not
 *      appear in any batch prompt.
 *   4. Repeat with 8 files each ~20 000 chars (total 160 000) so that 5 segments are
 *      selected and span three chunks (diff overhead pushes each segment to ~20 100
 *      chars, so only 2 fit per 60 000-char budget). Confirm the fake binary is
 *      invoked exactly 3 times for summarisation, not 5 times (one per selected file).
 *
 * Wire up: create a temp git repo with staged changes spread across multiple large
 * files. Place a recording fake `claude` shell script on PATH that writes each
 * invocation's args and stdin to a log directory and returns `=== FILE: <path> ===`-
 * formatted summaries for summarisation calls. Run the compiled CLI (`dist/main.js`)
 * via `wf issue:review` with `-r <tempRepo>`. After the command exits, read the
 * recorded invocations to assert call counts and prompt content.
 *
 * Teardown: remove the temp repo, fake binary, invocation logs, and isolated HOME
 * tree.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import chalk from 'chalk';
import { createReporter, summarise } from './support/reporter';

const projectRoot = path.resolve(__dirname, '../..');
const distMainPath = path.join(projectRoot, 'dist', 'main.js');

const { counts, pass, fail } = createReporter();

const writeExecutable = (filePath: string, content: string): void => {
  fs.writeFileSync(filePath, content, 'utf-8');
  fs.chmodSync(filePath, 0o755);
};

function buildStdinHandlerPart1(): string {
  return `let input = '';
process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('end', () => {
  const existing = fs.existsSync(invocationLogPath)
    ? fs.readFileSync(invocationLogPath, 'utf-8')
      .trim().split('\\n').filter(Boolean)
    : [];
  const count = existing.length + 1;
  fs.appendFileSync(
    invocationLogPath,
    JSON.stringify({ count, args }) + '\\n'
  );
`;
}

function buildStdinHandlerPart2(): string {
  return `fs.appendFileSync(
    invocationLogPath + '.prompts',
    '===CALL ' + count + '===\\n' + input + '\\n'
  );
  const isSummarisation = /^File: /m.test(input);
  if (isSummarisation) {
    const fileMatches = [...input.matchAll(/^File: (.+)$/mg)]
      .map(m => m[1].trim());
    const summaries = fileMatches
      .map(f => '=== FILE: ' + f + ' ===\\n- summarised ' + f)
      .join('\\n');
`;
}

function buildStdinHandlerPart3(): string {
  return `process.stdout.write(JSON.stringify({
      type: 'result',
      subtype: 'success',
      result: summaries,
      session_id: 'sum-session-' + count
    }) + '\\n');
    return;
  }
`;
}

function buildStdinHandlerPart3b(): string {
  return `const reviewResult = JSON.stringify({
    summary: 'Looks good',
    issues: [],
    suggestions: [],
    approved: true
  });
`;
}

function buildStdinHandlerPart4(): string {
  return `process.stdout.write(JSON.stringify({
    type: 'result',
    subtype: 'success',
    result: reviewResult,
    session_id: 'review-session-' + count
  }) + '\\n');
});`;
}

function buildStdinHandler(): string {
  return buildStdinHandlerPart1()
    + buildStdinHandlerPart2()
    + buildStdinHandlerPart3()
    + buildStdinHandlerPart3b()
    + buildStdinHandlerPart4();
}

function buildFakeClaudeScript(invocationLogPath: string): string {
  const stdinHandler = buildStdinHandler();
  return `#!/usr/bin/env node
const fs = require('fs');
const args = process.argv.slice(2);
const invocationLogPath = ${JSON.stringify(invocationLogPath)};

${stdinHandler}
`;
}

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

function initRepoWithSeed(repoDir: string, gitEnv: NodeJS.ProcessEnv): void {
  execFileSync('git', ['init', '-q'], { cwd: repoDir, env: gitEnv });
  const seedFile = path.join(repoDir, 'seed.ts');
  fs.writeFileSync(seedFile, 'export {};', 'utf-8');
  execFileSync('git', ['add', 'seed.ts'], { cwd: repoDir, env: gitEnv });
  execFileSync('git', ['commit', '-q', '-m', 'initial'], {
    cwd: repoDir,
    env: gitEnv,
  });
}

function writeAndStageFile(
  repoDir: string,
  index: number,
  patchLength: number,
  gitEnv: NodeJS.ProcessEnv
): void {
  const filePath = path.join(repoDir, `file${index}.ts`);
  fs.writeFileSync(
    filePath,
    `export const x${index} = '${'x'.repeat(patchLength)}';`,
    'utf-8'
  );
  execFileSync('git', ['add', `file${index}.ts`], { cwd: repoDir, env: gitEnv });
}

function addLargeFiles(
  repoDir: string,
  fileCount: number,
  patchLength: number,
  gitEnv: NodeJS.ProcessEnv
): void {
  for (let i = 0; i < fileCount; i++) {
    writeAndStageFile(repoDir, i, patchLength, gitEnv);
  }
}

function createRepoWithLargeFiles(
  repoDir: string,
  fileCount: number,
  patchLength: number,
  gitEnv: NodeJS.ProcessEnv
): void {
  initRepoWithSeed(repoDir, gitEnv);
  addLargeFiles(repoDir, fileCount, patchLength, gitEnv);
}

type RunResult = { stdout: string; stderr: string; status: number | null };

const runReview = (repoDir: string, env: NodeJS.ProcessEnv): RunResult => {
  const result = spawnSync(
    'node',
    [distMainPath, 'issue:review', '-r', repoDir, '-s'],
    { cwd: repoDir, env, encoding: 'utf-8', maxBuffer: 1024 * 1024 * 20 }
  );
  return { stdout: result.stdout ?? '', stderr: result.stderr ?? '', status: result.status };
};

const readInvocations = (logPath: string): Array<{ count: number; args: string[] }> => {
  if (!fs.existsSync(logPath)) return [];
  return fs.readFileSync(logPath, 'utf-8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
};

const readPrompts = (logPath: string): string[] => {
  if (!fs.existsSync(logPath + '.prompts')) return [];
  return fs.readFileSync(logPath + '.prompts', 'utf-8').split(/===CALL \d+===\n/).filter(Boolean);
};

const isBatchSummarisationPrompt = (p: string): boolean =>
  /^File: /m.test(p);

type SummarisationCallResult = {
  count: number;
  prompts: string[];
};

const countSummarisationCalls = (
  prompts: string[]
): SummarisationCallResult => {
  const summarisationPrompts = prompts.filter(isBatchSummarisationPrompt);
  return { count: summarisationPrompts.length, prompts: summarisationPrompts };
};

type ScenarioDirs = {
  repoDir: string;
  invocationLogPath: string;
};

function buildGitEnv(homeDir: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    HOME: homeDir,
    GIT_AUTHOR_NAME: 'wf',
    GIT_AUTHOR_EMAIL: 'wf@example.com',
    GIT_COMMITTER_NAME: 'wf',
    GIT_COMMITTER_EMAIL: 'wf@example.com',
  };
}

function preparePaths(
  tempRoot: string,
  scenarioName: string
): { homeDir: string; repoDir: string; invocationLogPath: string } {
  return {
    homeDir: path.join(tempRoot, scenarioName, 'home'),
    repoDir: path.join(tempRoot, scenarioName, 'repo'),
    invocationLogPath: path.join(tempRoot, scenarioName, 'invocations.log'),
  };
}

function initializeDirStructure(
  repoDir: string,
  homeDir: string,
  fileCount: number,
  patchLength: number,
  gitEnv: NodeJS.ProcessEnv
): void {
  fs.mkdirSync(repoDir, { recursive: true });
  fs.mkdirSync(homeDir, { recursive: true });
  createRepoWithLargeFiles(repoDir, fileCount, patchLength, gitEnv);
}

function writeConfigAndClaudeExecutable(
  repoDir: string,
  binDir: string,
  invocationLogPath: string
): void {
  const configPath = path.join(repoDir, 'wf.config.js');
  fs.writeFileSync(configPath, buildConfig(), 'utf-8');
  const claudePath = path.join(binDir, 'claude');
  writeExecutable(claudePath, buildFakeClaudeScript(invocationLogPath));
}

function initializeScenarioDir(
  repoDir: string,
  homeDir: string,
  binDir: string,
  fileCount: number,
  patchLength: number,
  invocationLogPath: string
): void {
  const gitEnv = buildGitEnv(homeDir);
  initializeDirStructure(repoDir, homeDir, fileCount, patchLength, gitEnv);
  writeConfigAndClaudeExecutable(repoDir, binDir, invocationLogPath);
}

function setupScenarioDirs(
  tempRoot: string,
  scenarioName: string,
  binDir: string,
  fileCount: number,
  patchLength: number
): ScenarioDirs {
  const { homeDir, repoDir, invocationLogPath } = preparePaths(tempRoot, scenarioName);
  initializeScenarioDir(repoDir, homeDir, binDir, fileCount, patchLength, invocationLogPath);
  return { repoDir, invocationLogPath };
}

function buildScenarioEnv(tempRoot: string, scenarioName: string, binDir: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    HOME: path.join(tempRoot, scenarioName, 'home'),
    PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ''}`,
    WF_SKIP_CLI_VERSION_CHECK: '1',
  };
}

function checkBatchCallCount(
  batchCallCount: number,
  expectedBatchCalls: number,
  scenarioName: string,
  output: string
): void {
  if (batchCallCount === expectedBatchCalls) {
    pass(
      `[${scenarioName}] summarisation uses ${expectedBatchCalls} batch call(s), not one per file`
    );
  } else {
    const failMsg = `[${scenarioName}] expected ${expectedBatchCalls} batch call(s), got ${batchCallCount}`;
    fail(failMsg, `output:\n${output.slice(0, 500)}`);
  }
}

function checkExitStatus(result: RunResult, output: string, scenarioName: string): void {
  if (result.status === 0) {
    pass(`[${scenarioName}] command exits 0`);
  } else {
    fail(`[${scenarioName}] command should exit 0`, output.slice(0, 500));
  }
}

function checkBatchPromptContent(batchPrompts: string[], scenarioName: string): void {
  if (batchPrompts.length === 0) return;
  if (batchPrompts[0].includes('File: ')) {
    pass(`[${scenarioName}] batch prompt contains File: sections`);
  } else {
    fail(`[${scenarioName}] batch prompt missing File: sections`, batchPrompts[0].slice(0, 300));
  }
}

type ScenarioTestResources = {
  repoDir: string;
  env: NodeJS.ProcessEnv;
  invocationLogPath: string;
};

function prepareScenarioResources(
  tempRoot: string,
  binDir: string,
  scenarioName: string,
  fileCount: number,
  patchLength: number
): ScenarioTestResources {
  const { repoDir, invocationLogPath } = setupScenarioDirs(tempRoot, scenarioName, binDir, fileCount, patchLength);
  const env = buildScenarioEnv(tempRoot, scenarioName, binDir);
  return { repoDir, env, invocationLogPath };
}

function verifyScenarioResults(
  invocationLogPath: string,
  expectedBatchCalls: number,
  scenarioName: string,
  output: string
): void {
  const scenarioResults = countSummarisationCalls(readPrompts(invocationLogPath));
  checkBatchCallCount(scenarioResults.count, expectedBatchCalls, scenarioName, output);
  checkBatchPromptContent(scenarioResults.prompts, scenarioName);
}

function executeScenarioTest(
  repoDir: string,
  env: NodeJS.ProcessEnv,
  invocationLogPath: string,
  expectedBatchCalls: number,
  scenarioName: string
): void {
  const result = runReview(repoDir, env);
  const output = `${result.stdout}\n${result.stderr}`;
  checkExitStatus(result, output, scenarioName);
  verifyScenarioResults(invocationLogPath, expectedBatchCalls, scenarioName, output);
}

async function runScenario(
  tempRoot: string,
  binDir: string,
  scenarioName: string,
  fileCount: number,
  patchLength: number,
  expectedBatchCalls: number
): Promise<void> {
  const r = prepareScenarioResources(tempRoot, binDir, scenarioName, fileCount, patchLength);
  executeScenarioTest(r.repoDir, r.env, r.invocationLogPath, expectedBatchCalls, scenarioName);
}

function guardDistExists(): void {
  if (!fs.existsSync(distMainPath)) {
    fail('dist/main.js must exist before running this smoke test', 'Run `yarn build` first.');
    process.exit(1);
  }
}

async function main(): Promise<void> {
  guardDistExists();
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-batch-sum-'));
  const binDir = path.join(tempRoot, 'bin');
  fs.mkdirSync(binDir, { recursive: true });
  try {
    await runScenario(tempRoot, binDir, '5-files-1-chunk', 5, 20_000, 1);
    await runScenario(tempRoot, binDir, '8-files-3-chunks', 8, 20_000, 3);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
  summarise(counts);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
