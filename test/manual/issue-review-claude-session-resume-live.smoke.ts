/**
 * Manual smoke test: Claude CLI review retry resumes session instead of fresh-starting
 *
 * Run: nr test:manual -- test-issue-review-claude-session-resume-live
 *
 * Scenario: S4 removed `handleReviewFreshStart`, which used to null out the
 * session id on every review-stage retry. Live-verify a review-stage
 * "no usable result" (assistant-text-only) retry now resumes the SAME
 * Claude session rather than starting a brand-new session with the full
 * prompt from zero.
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
 *   1. The fake `claude` binary's SECOND invocation (the schema-retry
 *      repair pass) carries `--resume sess-review-1` — the session id
 *      emitted by the first (no-result) invocation — not a missing/absent
 *      `--resume` flag.
 *   2. That second invocation's piped prompt is the short `cliRetryPrompt`
 *      repair prompt, not the full original review prompt re-sent from
 *      scratch.
 *   3. The command exits 0 with the pass-2 review result. A third
 *      invocation (the post-review CLI epilogue, unrelated pre-existing
 *      behavior) is expected and not itself under test here.
 *
 * Wire up: a real temp git repo with one committed file and one uncommitted
 * edit (so `wf issue:review` has a real diff to review). Fake `claude`
 * script — first invocation emits an assistant "thinking..." message with
 * a `session_id` but no `result` line (treated as no-usable-result);
 * second invocation (carrying `--resume`) emits a valid
 * `codeReviewSchema`-shaped result; any further invocation (the epilogue)
 * emits a short plain-text summary.
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

const runCommand = (cwd: string, env: NodeJS.ProcessEnv): SpawnResult => {
  const result = spawnSync(
    'node',
    [distMainPath, 'issue:review', '-r', cwd, '-s'],
    { cwd, env, encoding: 'utf-8', maxBuffer: 1024 * 1024 * 10 }
  );

  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
};

const validReviewJson = JSON.stringify({
  summary: 'Looks good',
  issues: [],
  suggestions: [],
  approved: true,
});

const buildFakeClaudeScript = (invocationLogPath: string): string => `#!/usr/bin/env node
const fs = require('fs');
const args = process.argv.slice(2);

fs.appendFileSync(${JSON.stringify(invocationLogPath)}, JSON.stringify(args) + '\\n');

const isResume = args.includes('--resume');

let input = '';
process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('end', () => {
  fs.appendFileSync(${JSON.stringify(invocationLogPath)}.replace(/\\.log$/, '.prompts.log'), input + '\\n---\\n');

  const invocationCount = fs.readFileSync(${JSON.stringify(invocationLogPath)}, 'utf-8').trim().split('\\n').filter(Boolean).length;

  if (!isResume) {
    console.log(JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'thinking...' }] },
      session_id: 'sess-review-1',
    }));
    return;
  }
  if (invocationCount === 2) {
    console.log(JSON.stringify({ type: 'result', subtype: 'success', result: ${JSON.stringify(validReviewJson)}, session_id: 'sess-review-1' }));
    return;
  }
  console.log(JSON.stringify({
    type: 'result', subtype: 'success', result: 'Review summary: looks good.', session_id: 'sess-review-1',
  }));
});
`;

async function main(): Promise<void> {
  if (!fs.existsSync(distMainPath)) {
    fail('dist/main.js must exist before running this smoke test', 'Run `yarn build` first.');
    process.exit(1);
  }

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-claude-review-resume-'));
  const homeDir = path.join(tempRoot, 'home');
  const repoDir = path.join(tempRoot, 'repo');
  const binDir = path.join(tempRoot, 'bin');
  const configPath = path.join(repoDir, 'wf.config.js');
  const claudeScriptPath = path.join(binDir, 'claude');
  const invocationLogPath = path.join(tempRoot, 'invocations.log');
  const promptsLogPath = path.join(tempRoot, 'invocations.prompts.log');
  const trackedFilePath = path.join(repoDir, 'src.ts');

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

    const result = runCommand(repoDir, env);
    const output = `${result.stdout}\n${result.stderr}`;
    const invocations = fs.existsSync(invocationLogPath)
      ? fs.readFileSync(invocationLogPath, 'utf-8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
      : [];
    const prompts = fs.existsSync(promptsLogPath)
      ? fs.readFileSync(promptsLogPath, 'utf-8').split('\n---\n').filter(Boolean)
      : [];

    if (invocations.length >= 2) {
      pass('fake claude binary was invoked at least twice (schema-retry pair, plus optional epilogue)');
    } else {
      fail('expected at least 2 claude invocations', `got ${invocations.length}: ${JSON.stringify(invocations)}\noutput:\n${output}`);
    }

    const secondArgs = invocations[1] ?? [];
    if (secondArgs.includes('--resume') && secondArgs.includes('sess-review-1')) {
      pass('second invocation resumes session sess-review-1');
    } else {
      fail('second invocation should carry --resume sess-review-1', JSON.stringify(secondArgs));
    }

    const firstPrompt = prompts[0] ?? '';
    const secondPrompt = prompts[1] ?? '';
    if (secondPrompt.length < firstPrompt.length && secondPrompt.includes('usable result')) {
      pass('second invocation sends the short repair prompt, not the full original review prompt');
    } else {
      fail(
        'second invocation should send the short repair prompt',
        `first (${firstPrompt.length} chars) / second (${secondPrompt.length} chars): ${secondPrompt.slice(0, 300)}`
      );
    }

    if (result.status === 0) {
      pass('command exits 0');
    } else {
      fail('command should exit 0', output);
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
