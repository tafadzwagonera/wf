/**
 * Manual smoke test: a cached review artifact short-circuits before criteria reaches the AI, and --force restores it
 *
 * Run: nr test:manual review-artifact-cache-skips-criteria-application.smoke.ts
 *
 * Scenario: The user runs `wf issue:review -k <ticket> --criteria <file>`
 * twice against the same ticket key. The first run has no cached artifact and
 * must reach the AI with the criteria applied. The second run (no --force)
 * must hit the cached artifact and exit before ever invoking the AI provider.
 * A third run with `--force` must bypass the cache and invoke the AI again
 * with the criteria applied, producing a fresh artifact.
 *
 * Config under test:
 *   ai: [
 *     { provider: 'anthropic', model: 'claude-sonnet-4-6', default: true, apiKey: 'k' },
 *   ]
 *   stages: {
 *     review: { provider: 'anthropic', backend: 'cli' }
 *   }
 *
 * Verify:
 *   1. Run 1 (no cached artifact yet): exits 0, and the fake claude
 *      executable's invocation count is 1.
 *   2. A review artifact file now exists on disk at the ticket's cache path.
 *   3. Run 2 (same command, no --force): exits 0, stdout is exactly the
 *      cached artifact path (silent-mode cache-hit contract), and the
 *      invocation count is unchanged (the AI was never called).
 *   4. Run 3 (same command plus --force): exits 0, and the invocation count
 *      increases by one (the AI was called again).
 *   5. Run 3's captured prompt (the second fake-claude invocation) contains
 *      the custom criteria's guideline text, confirming --force both bypasses
 *      the cache and still carries the criteria through.
 *
 * Wire up: build the project first, create one temp git repo with a real diff
 * and a temp WF_HOME. Ticket fetch is stubbed by preloading a script (via
 * node's -r flag) that monkeypatches http.request in-process to return a
 * canned Jira ticket payload for the matching host/port/path, so no real
 * socket is ever opened for it — a live local HTTP server here previously
 * hung indefinitely because this environment blocks outbound network
 * connections from nested child processes, even to localhost; an in-process
 * intercept has no such restriction (no Bitbucket/GitHub config either, so PR
 * discovery is skipped and the command falls back to reviewing the local diff
 * automatically). Place a fake `claude` executable ahead of PATH that
 * increments an invocation counter file and logs captured stdin to disk on
 * every call, returning a valid CodeReview JSON result each time. Run the
 * compiled CLI via node -r <stub> dist/main.js issue:review -k <ticket>
 * --criteria <path> -s three times in sequence against the same WF_HOME/repo
 * without resetting state between runs 1 and 2, then add --force for run 3,
 * asserting stdout content and invocation-count deltas at each step.
 * Teardown: remove the temp repo, fake bin directory, isolated WF_HOME, and
 * prompt/invocation logs; restore environment variables.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import chalk from 'chalk';
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

const validReviewJson = JSON.stringify({
  summary: 'Looks good',
  issues: [],
  suggestions: [],
  approved: true,
});

const CRITERIA_MARKDOWN = [
  '## Custom rule',
  '',
  '- Every deferral carries TODO(WBP-####) in code, with a real assigned ticket.',
  '',
].join('\n');

const CUSTOM_GUIDELINE = 'Custom rule: Every deferral carries TODO(WBP-####) in code, with a real assigned ticket.';
const TICKET_KEY = 'WBP-9999';
const JIRA_HOST = '127.0.0.1';
const JIRA_PORT = 4599;
const JIRA_PATH = `/rest/api/3/issue/${TICKET_KEY}`;

const buildFakeClaudeScript = (invocationLogPath: string, promptsLogPath: string): string => `#!/usr/bin/env node
const fs = require('fs');
const args = process.argv.slice(2);

fs.appendFileSync(${JSON.stringify(invocationLogPath)}, JSON.stringify(args) + '\\n');

let input = '';
process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('end', () => {
  fs.appendFileSync(${JSON.stringify(promptsLogPath)}, input + '\\n---\\n');

  console.log(JSON.stringify({
    type: 'result', subtype: 'success', result: ${JSON.stringify(validReviewJson)}, session_id: 'sess-cache-1',
  }));
});
`;

const countInvocations = (invocationLogPath: string): number =>
  fs.existsSync(invocationLogPath)
    ? fs.readFileSync(invocationLogPath, 'utf-8').trim().split('\n').filter(Boolean).length
    : 0;

const FAKE_JIRA_TICKET_PAYLOAD = JSON.stringify({
  key: TICKET_KEY,
  id: '10001',
  fields: {
    summary: 'Fake ticket for cache-vs-force smoke test',
    description: null,
    status: { name: 'Open' },
    issuetype: { name: 'Bug' },
    priority: { name: 'Medium' },
    assignee: null,
    reporter: null,
    created: '2026-01-01T00:00:00.000Z',
    updated: '2026-01-01T00:00:00.000Z',
    labels: [],
    components: [],
  },
});

const jiraStubTemplate = `
const http = require('http');
const { EventEmitter } = require('events');
const { Readable } = require('stream');

const originalRequest = http.request;

http.request = function (options, callback) {
  const opts = typeof options === 'string' ? new URL(options) : options;
  const hostname = opts.hostname || opts.host;
  const port = Number(opts.port) || 80;
  const reqPath = opts.path || opts.pathname || '/';

  if (hostname === ${JSON.stringify(JIRA_HOST)} && port === ${JIRA_PORT} && reqPath === ${JSON.stringify(
    JIRA_PATH
  )}) {
    const req = new EventEmitter();
    req.write = () => true;
    req.setTimeout = () => req;
    req.destroy = () => {};
    req.abort = () => {};
    req.setHeader = () => {};
    req.setNoDelay = () => {};
    req.setSocketKeepAlive = () => {};
    req.flushHeaders = () => {};
    req.end = () => {
      const res = new Readable({ read() {} });
      res.statusCode = 200;
      res.headers = { 'content-type': 'application/json' };
      if (typeof callback === 'function') callback(res);
      req.emit('response', res);
      process.nextTick(() => {
        res.push(${JSON.stringify(FAKE_JIRA_TICKET_PAYLOAD)});
        res.push(null);
      });
      return req;
    };
    return req;
  }

  return originalRequest.apply(http, arguments);
};
`;

function buildJiraHttpStubScript(): string {
  return jiraStubTemplate;
}

interface TestPaths {
  wfHomeDir: string;
  repoDir: string;
  binDir: string;
  invocationLogPath: string;
  promptsLogPath: string;
  criteriaPath: string;
  jiraStubPath: string;
  reviewArtifactPath: string;
}

function buildTestPaths(tempRoot: string): TestPaths {
  const wfHomeDir = path.join(tempRoot, 'wfhome');
  const repoDir = path.join(tempRoot, 'repo');
  const binDir = path.join(tempRoot, 'bin');
  return {
    wfHomeDir, repoDir, binDir,
    invocationLogPath: path.join(tempRoot, 'invocations.log'),
    promptsLogPath: path.join(tempRoot, 'invocations.prompts.log'),
    criteriaPath: path.join(tempRoot, 'criteria.md'),
    jiraStubPath: path.join(tempRoot, 'jira-http-stub.js'),
    reviewArtifactPath: path.join(wfHomeDir, path.basename(repoDir), 'jira', `${TICKET_KEY}-review.md`),
  };
}

function setupDirs(paths: TestPaths): void {
  fs.mkdirSync(paths.repoDir, { recursive: true });
  fs.mkdirSync(paths.binDir, { recursive: true });
  fs.mkdirSync(path.join(paths.wfHomeDir, 'logs'), { recursive: true });
  fs.mkdirSync(path.join(paths.wfHomeDir, 'state'), { recursive: true });
  fs.mkdirSync(path.dirname(paths.reviewArtifactPath), { recursive: true });
}

function setupRepo(paths: TestPaths): void {
  const gitEnv = { ...process.env, GIT_AUTHOR_NAME: 'wf', GIT_AUTHOR_EMAIL: 'wf@example.com', GIT_COMMITTER_NAME: 'wf', GIT_COMMITTER_EMAIL: 'wf@example.com' };
  execFileSync('git', ['init', '-q'], { cwd: paths.repoDir, env: gitEnv });
  fs.writeFileSync(path.join(paths.repoDir, 'src.ts'), 'line 1\nline 2\n', 'utf-8');
  execFileSync('git', ['add', 'src.ts'], { cwd: paths.repoDir, env: gitEnv });
  execFileSync('git', ['commit', '-q', '-m', 'initial'], { cwd: paths.repoDir, env: gitEnv });
  fs.writeFileSync(path.join(paths.repoDir, 'src.ts'), 'line 1\nline 2\nline 3 added\n', 'utf-8');
}

const configLines = [
  'module.exports = {',
  '  ai: [',
  "    { provider: 'anthropic', model: 'claude-sonnet-4-6', default: true, apiKey: 'test-key' },",
  '  ],',
  '  atlassian: {',
  `    baseUrl: 'http://${JIRA_HOST}:${JIRA_PORT}',`,
  "    email: 'dev@example.com',",
  "    jira: { apiToken: 'fake-jira-token' },",
  '  },',
  '  stages: {',
  "    review: { provider: 'anthropic', backend: 'cli', model: 'claude-sonnet-4-6' },",
  '  },',
  '};',
  '',
];

function buildConfigLines(): string[] {
  return configLines;
}

function buildConfigContent(): string {
  return buildConfigLines().join('\n');
}

function writeConfig(configPath: string): void {
  fs.writeFileSync(configPath, buildConfigContent(), 'utf-8');
}

function setupFiles(paths: TestPaths): void {
  fs.writeFileSync(paths.criteriaPath, CRITERIA_MARKDOWN, 'utf-8');
  fs.writeFileSync(paths.jiraStubPath, buildJiraHttpStubScript(), 'utf-8');
  writeConfig(path.join(paths.repoDir, 'wf.config.js'));
  writeExecutable(path.join(paths.binDir, 'claude'), buildFakeClaudeScript(paths.invocationLogPath, paths.promptsLogPath));
}

function buildRunEnv(paths: TestPaths): NodeJS.ProcessEnv {
  return {
    ...process.env,
    HOME: os.homedir(),
    WF_HOME: paths.wfHomeDir,
    PATH: `${paths.binDir}${path.delimiter}${process.env.PATH ?? ''}`,
    WF_SKIP_CLI_VERSION_CHECK: '1',
  };
}

function buildBaseCliArgs(paths: TestPaths): string[] {
  return [
    '-r',
    paths.jiraStubPath,
    distMainPath,
    'issue:review',
    '-r',
    paths.repoDir,
    '-k',
    TICKET_KEY,
    '--criteria',
    paths.criteriaPath,
    '-s',
  ];
}

function buildCliReviewArgs(paths: TestPaths, extraArgs: string[]): string[] {
  return [...buildBaseCliArgs(paths), ...extraArgs];
}

function runCliReview(
  paths: TestPaths,
  env: NodeJS.ProcessEnv,
  extraArgs: string[]
): SpawnResult {
  const args = buildCliReviewArgs(paths, extraArgs);
  const result = spawnSync('node', args, {
    cwd: paths.repoDir,
    env,
    encoding: 'utf-8',
    maxBuffer: 1024 * 1024 * 10,
    timeout: 30000,
  });
  return result as SpawnResult;
}

function checkRun1(run1: SpawnResult, run1InvocationCount: number, invocationsPerReview: number): void {
  if (run1.status === 0 && run1InvocationCount > 0) {
    pass(`run 1 (no cache) exits 0 and calls the AI (${invocationsPerReview} invocation(s): review + epilogue)`);
  } else {
    fail('run 1 (no cache) should exit 0 and call the AI', `${run1.stdout}\n${run1.stderr}`);
  }
}

function checkArtifactWritten(reviewArtifactPath: string): void {
  if (fs.existsSync(reviewArtifactPath)) {
    pass('review artifact now exists on disk after run 1');
  } else {
    fail('review artifact should exist on disk after run 1', reviewArtifactPath);
  }
}

function checkRun2Status(run2: SpawnResult, reviewArtifactPath: string): void {
  if (run2.status === 0 && run2.stdout.includes(reviewArtifactPath)) {
    pass('run 2 (cached, no --force) exits 0 and prints the cached artifact path');
  } else {
    fail('run 2 should exit 0 and print the cached artifact path', `${run2.stdout}\n${run2.stderr}`);
  }
}

function checkRun2InvocationCount(
  run2InvocationCount: number,
  run1InvocationCount: number,
  run2: SpawnResult
): void {
  if (run2InvocationCount === run1InvocationCount) {
    pass('run 2 never calls the AI — invocation count unchanged');
  } else {
    fail(
      'run 2 should never call the AI',
      `output: ${run2.stdout}\ninvocationCount: ${run2InvocationCount}`
    );
  }
}

function checkRun2(
  run2: SpawnResult,
  run2InvocationCount: number,
  run1InvocationCount: number,
  reviewArtifactPath: string
): void {
  checkRun2Status(run2, reviewArtifactPath);
  checkRun2InvocationCount(run2InvocationCount, run1InvocationCount, run2);
}

function verifyRun3BypassedCache(
  run3: SpawnResult,
  run3InvocationCount: number,
  run1InvocationCount: number,
  invocationsPerReview: number
): boolean {
  return (
    run3.status === 0
    && run3InvocationCount === run1InvocationCount + invocationsPerReview
  );
}

function logRun3Failure(run3: SpawnResult, run3InvocationCount: number): void {
  fail(
    'run 3 (--force) should bypass the cache and call the AI again',
    `output: ${run3.stdout}\ninvocationCount: ${run3InvocationCount}`
  );
}

function checkRun3Status(
  run3: SpawnResult,
  run3InvocationCount: number,
  run1InvocationCount: number,
  invocationsPerReview: number
): void {
  if (verifyRun3BypassedCache(run3, run3InvocationCount, run1InvocationCount, invocationsPerReview)) {
    pass('run 3 (--force) bypasses the cache and calls the AI again');
  } else {
    logRun3Failure(run3, run3InvocationCount);
  }
}

function getRun3Prompt(
  promptsLogPath: string,
  run3InvocationCount: number,
  invocationsPerReview: number
): string {
  const prompts = fs.existsSync(promptsLogPath)
    ? fs.readFileSync(promptsLogPath, 'utf-8').split('\n---\n').filter(Boolean)
    : [];
  return prompts[run3InvocationCount - invocationsPerReview] ?? '';
}

function checkRun3PromptContent(run3Prompt: string): void {
  if (run3Prompt.includes(CUSTOM_GUIDELINE)) {
    pass('run 3 prompt still carries the custom criteria guideline through --force');
  } else {
    fail(
      'run 3 prompt should carry the custom criteria guideline through --force',
      run3Prompt.slice(0, 800)
    );
  }
}

function checkRun3AndPrompt(
  run3: SpawnResult,
  run3InvocationCount: number,
  run1InvocationCount: number,
  invocationsPerReview: number,
  promptsLogPath: string
): void {
  checkRun3Status(run3, run3InvocationCount, run1InvocationCount, invocationsPerReview);
  const run3Prompt = getRun3Prompt(promptsLogPath, run3InvocationCount, invocationsPerReview);
  checkRun3PromptContent(run3Prompt);
}

async function runScenario(paths: TestPaths, env: NodeJS.ProcessEnv): Promise<void> {
  const run1 = runCliReview(paths, env, []);
  const count1 = countInvocations(paths.invocationLogPath);
  checkRun1(run1, count1, count1);
  checkArtifactWritten(paths.reviewArtifactPath);
  const run2 = runCliReview(paths, env, []);
  checkRun2(run2, countInvocations(paths.invocationLogPath), count1, paths.reviewArtifactPath);
  const run3 = runCliReview(paths, env, ['--force']);
  checkRun3AndPrompt(run3, countInvocations(paths.invocationLogPath), count1, count1, paths.promptsLogPath);
}

function checkDistExists(): void {
  if (fs.existsSync(distMainPath)) {
    pass('dist/main.js exists');
  } else {
    fail('dist/main.js must exist before running this smoke test', 'Run `yarn build` first.');
    process.exit(1);
  }
}

async function main(): Promise<void> {
  checkDistExists();
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-cache-criteria-'));
  try {
    const paths = buildTestPaths(tempRoot);
    setupDirs(paths);
    setupFiles(paths);
    setupRepo(paths);
    await runScenario(paths, buildRunEnv(paths));
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
  summarise(counts);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
