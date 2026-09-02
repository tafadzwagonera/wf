/**
 * Manual smoke test: Review issue line numbers survive post-processing (S1 diff-threading fix)
 *
 * Run: nr test:manual -- test-issue-review-diff-line-numbers-live
 *
 * Scenario: `parseAndProcessReview` used to pass the model's own JSON
 * response into `sanitizeCodeReviewTrace`/`postProcessCodeReview` where the
 * real diff belonged, silently stripping every issue's `line`/`endLine`.
 * Live-verify a full `issue:review` run against a real unified diff
 * preserves accurate line numbers in the saved review output.
 *
 * Config under test:
 *   ai: [
 *     { provider: 'anthropic', model: 'claude-sonnet-4-6', default: true }
 *   ]
 *   stages: {
 *     review: { provider: 'anthropic', backend: 'cli' }
 *   }
 *
 * Verify:
 *   1. The command exits 0.
 *   2. The saved review output attributes the one issue to the exact
 *      changed-line number present in the real git diff (line 3 of a
 *      3-line file where line 3 was added), not `undefined`/stripped.
 *   3. The issue's file path matches the diff's destination-side path.
 *
 * Wire up: a real temp git repo with one committed file and one uncommitted
 * edit that adds a line, so `wf issue:review` builds its diff from a real
 * `git diff`. Fake `claude` binary returns a `codeReviewSchema` payload
 * whose one issue anchors `file`/`line` to the known added line.
 * Teardown: remove the temp repo, fake executable, and isolated `HOME` tree.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import chalk from 'chalk';
import { createReporter } from './support/reporter';

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

const runCommand = (cwd: string, outputPath: string, env: NodeJS.ProcessEnv): SpawnResult => {
  const result = spawnSync(
    'node',
    [distMainPath, 'issue:review', '-r', cwd, '-s', '-o', outputPath, '-f', 'json'],
    { cwd, env, encoding: 'utf-8', maxBuffer: 1024 * 1024 * 10 }
  );

  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
};

const buildReviewJson = (): string =>
  JSON.stringify({
    summary: 'One issue found',
    issues: [
      { file: 'src.ts', line: 3, message: 'Issue anchored at the added line', severity: 'warning' },
    ],
    suggestions: [],
    approved: false,
  });

const buildFakeClaudeScript = (invocationLogPath: string): string => `#!/usr/bin/env node
const fs = require('fs');
const args = process.argv.slice(2);

fs.appendFileSync(${JSON.stringify(invocationLogPath)}, JSON.stringify(args) + '\\n');

let input = '';
process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('end', () => {
  console.log(JSON.stringify({ type: 'result', subtype: 'success', result: ${JSON.stringify(buildReviewJson())}, session_id: 'sess-diff-1' }));
});
`;

async function main(): Promise<void> {
  if (!fs.existsSync(distMainPath)) {
    fail('dist/main.js must exist before running this smoke test', 'Run `yarn build` first.');
    process.exit(1);
  }

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-review-diff-lines-'));
  const homeDir = path.join(tempRoot, 'home');
  const repoDir = path.join(tempRoot, 'repo');
  const binDir = path.join(tempRoot, 'bin');
  const configPath = path.join(repoDir, 'wf.config.js');
  const claudeScriptPath = path.join(binDir, 'claude');
  const invocationLogPath = path.join(tempRoot, 'invocations.log');
  const trackedFilePath = path.join(repoDir, 'src.ts');
  const outputPath = path.join(tempRoot, 'review-output.json');

  try {
    fs.mkdirSync(repoDir, { recursive: true });
    fs.mkdirSync(binDir, { recursive: true });
    fs.mkdirSync(homeDir, { recursive: true });
    fs.mkdirSync(path.join(homeDir, '.wf', 'logs'), { recursive: true });
    fs.mkdirSync(path.join(homeDir, '.wf', 'state'), { recursive: true });

    const gitEnv = { ...process.env, HOME: homeDir, GIT_AUTHOR_NAME: 'wf', GIT_AUTHOR_EMAIL: 'wf@example.com', GIT_COMMITTER_NAME: 'wf', GIT_COMMITTER_EMAIL: 'wf@example.com' };
    execFileSync('git', ['init', '-q'], { cwd: repoDir, env: gitEnv });
    fs.writeFileSync(trackedFilePath, 'line 1\nline 2\n', 'utf-8');
    execFileSync('git', ['add', 'src.ts'], { cwd: repoDir, env: gitEnv });
    execFileSync('git', ['commit', '-q', '-m', 'initial'], { cwd: repoDir, env: gitEnv });
    fs.writeFileSync(trackedFilePath, 'line 1\nline 2\nline 3 added\n', 'utf-8');

    fs.writeFileSync(
      configPath,
      [
        'module.exports = {',
        '  ai: [',
        "    { provider: 'anthropic', model: 'claude-sonnet-4-6', default: true, apiKey: 'test-key' },",
        '  ],',
        '  stages: {',
        "    review: { provider: 'anthropic', backend: 'cli', model: 'claude-sonnet-4-6' },",
        '  },',
        '};',
        '',
      ].join('\n'),
      'utf-8'
    );

    writeExecutable(claudeScriptPath, buildFakeClaudeScript(invocationLogPath));

    const env = {
      ...process.env,
      HOME: homeDir,
      PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ''}`,
      WF_SKIP_CLI_VERSION_CHECK: '1',
    };

    const result = runCommand(repoDir, outputPath, env);
    const output = `${result.stdout}\n${result.stderr}`;

    if (result.status === 0) {
      pass('command exits 0');
    } else {
      fail('command should exit 0', output);
    }

    if (!fs.existsSync(outputPath)) {
      fail('expected a saved review output file', `outputPath: ${outputPath}\noutput:\n${output}`);
    } else {
      const saved = JSON.parse(fs.readFileSync(outputPath, 'utf-8'));
      const issues = Array.isArray(saved) ? saved[0]?.review?.issues : saved?.review?.issues ?? saved?.issues;
      const issue = Array.isArray(issues) ? issues[0] : undefined;

      if (issue?.line === 3) {
        pass('review issue line number survives post-processing (line 3, the real added line)');
      } else {
        fail('review issue line should survive as 3', JSON.stringify(saved));
      }

      if (typeof issue?.file === 'string' && issue.file.replace(/^[ab]\//, '') === 'src.ts') {
        pass('review issue file path matches the diff destination path');
      } else {
        fail('review issue file should match src.ts', JSON.stringify(issue));
      }
    }
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }

  console.log(chalk.bold(`\nSummary: ${counts.passed} passed, ${counts.failed} failed`));
  process.exit(counts.failed > 0 ? 1 : 0);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
