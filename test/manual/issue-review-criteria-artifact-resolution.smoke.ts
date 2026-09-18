/**
 * Manual smoke test: issue:review criteria resolves bare filenames from the artifact namespace
 *
 * Run: nr test:manual -- issue-review-criteria-artifact-resolution.smoke
 *
 * Scenario: The user passes `--criteria review-guidelines.md` from a repository
 * that also contains a cwd decoy file with the same name. wf must resolve the
 * bare criteria filename through the custom-source artifact rules, loading
 * `$WF_HOME/<repo>/review-guidelines.md`, not `<repo>/review-guidelines.md`.
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
 *   1. A temp repo contains review-guidelines.md with decoy text that must not
 *      appear in the review prompt.
 *   2. $WF_HOME/<repo-basename>/review-guidelines.md contains artifact criteria
 *      text that must appear in the review prompt.
 *   3. Running `node dist/main.js issue:review -r <repo> --criteria
 *      review-guidelines.md -s` exits 0.
 *   4. The fake CLI's captured stdin includes the artifact criteria text.
 *   5. The fake CLI's captured stdin does not include the cwd decoy criteria
 *      text.
 *   6. The command does not report "Criteria file not found".
 *
 * Wire up: build the project first, create a temp git repo with a real diff,
 * write wf.config.js for Claude CLI review, and place a fake `claude`
 * executable ahead of PATH. The fake claude logs stdin and returns a valid
 * CodeReview JSON result for the review turn plus a plain epilogue result for
 * any follow-up. Use an absolute temporary WF_HOME and create the artifact
 * criteria file under $WF_HOME/<repo-basename>/. Run the compiled CLI via
 * node dist/main.js rather than constructing command classes directly.
 * Teardown: remove the temp repo, fake bin directory, isolated WF_HOME, and
 * prompt logs; restore environment variables.
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

const validReviewJson = JSON.stringify({
  summary: 'Looks good',
  issues: [],
  suggestions: [],
  approved: true,
});

const ARTIFACT_CRITERIA_TEXT = 'ARTIFACT-CRITERIA-MARKER: check for dangling promises';
const DECOY_CRITERIA_TEXT = 'DECOY-CRITERIA-MARKER: this text must never reach the prompt';

const buildFakeClaudeScript = (invocationLogPath: string, promptsLogPath: string): string => `#!/usr/bin/env node
const fs = require('fs');
const args = process.argv.slice(2);

fs.appendFileSync(${JSON.stringify(invocationLogPath)}, JSON.stringify(args) + '\\n');

let input = '';
process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('end', () => {
  fs.appendFileSync(${JSON.stringify(promptsLogPath)}, input + '\\n---\\n');

  const invocationCount = fs.readFileSync(${JSON.stringify(invocationLogPath)}, 'utf-8').trim().split('\\n').filter(Boolean).length;

  if (invocationCount === 1) {
    console.log(JSON.stringify({ type: 'result', subtype: 'success', result: ${JSON.stringify(validReviewJson)}, session_id: 'sess-criteria-1' }));
    return;
  }
  console.log(JSON.stringify({
    type: 'result', subtype: 'success', result: 'Review summary: looks good.', session_id: 'sess-criteria-1',
  }));
});
`;

async function main(): Promise<void> {
  if (!fs.existsSync(distMainPath)) {
    fail('dist/main.js must exist before running this smoke test', 'Run `yarn build` first.');
    process.exit(1);
  }

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-criteria-artifact-'));
  const wfHomeDir = path.join(tempRoot, 'wfhome');
  const repoDir = path.join(tempRoot, 'repo');
  const binDir = path.join(tempRoot, 'bin');
  const configPath = path.join(repoDir, 'wf.config.js');
  const claudeScriptPath = path.join(binDir, 'claude');
  const invocationLogPath = path.join(tempRoot, 'invocations.log');
  const promptsLogPath = path.join(tempRoot, 'invocations.prompts.log');
  const trackedFilePath = path.join(repoDir, 'src.ts');
  const repoBasename = path.basename(repoDir);
  const artifactCriteriaPath = path.join(wfHomeDir, repoBasename, 'review-guidelines.md');
  const decoyCriteriaPath = path.join(repoDir, 'review-guidelines.md');

  try {
    fs.mkdirSync(repoDir, { recursive: true });
    fs.mkdirSync(binDir, { recursive: true });
    fs.mkdirSync(path.join(wfHomeDir, repoBasename), { recursive: true });
    fs.mkdirSync(path.join(wfHomeDir, 'logs'), { recursive: true });
    fs.mkdirSync(path.join(wfHomeDir, 'state'), { recursive: true });

    fs.writeFileSync(artifactCriteriaPath, `- ${ARTIFACT_CRITERIA_TEXT}\n`, 'utf-8');
    fs.writeFileSync(decoyCriteriaPath, `- ${DECOY_CRITERIA_TEXT}\n`, 'utf-8');

    const gitEnv = { ...process.env, GIT_AUTHOR_NAME: 'wf', GIT_AUTHOR_EMAIL: 'wf@example.com', GIT_COMMITTER_NAME: 'wf', GIT_COMMITTER_EMAIL: 'wf@example.com' };
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

    writeExecutable(claudeScriptPath, buildFakeClaudeScript(invocationLogPath, promptsLogPath));

    const env = {
      ...process.env,
      HOME: os.homedir(),
      WF_HOME: wfHomeDir,
      PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ''}`,
      WF_SKIP_CLI_VERSION_CHECK: '1',
    };

    const result = spawnSync(
      'node',
      [distMainPath, 'issue:review', '-r', repoDir, '--criteria', 'review-guidelines.md', '-s'],
      { cwd: repoDir, env, encoding: 'utf-8', maxBuffer: 1024 * 1024 * 10 }
    ) as SpawnResult;
    const output = `${result.stdout}\n${result.stderr}`;

    const prompts = fs.existsSync(promptsLogPath)
      ? fs.readFileSync(promptsLogPath, 'utf-8').split('\n---\n').filter(Boolean)
      : [];
    const firstPrompt = prompts[0] ?? '';

    if (result.status === 0) {
      pass('command exits 0');
    } else {
      fail('command should exit 0', output);
    }

    if (firstPrompt.includes(ARTIFACT_CRITERIA_TEXT)) {
      pass('review prompt includes artifact criteria text');
    } else {
      fail('review prompt should include artifact criteria text', firstPrompt.slice(0, 500));
    }

    if (!firstPrompt.includes(DECOY_CRITERIA_TEXT)) {
      pass('review prompt does not include cwd decoy criteria text');
    } else {
      fail('review prompt should not include cwd decoy criteria text', firstPrompt.slice(0, 500));
    }

    if (!output.includes('Criteria file not found')) {
      pass('output does not report "Criteria file not found"');
    } else {
      fail('output should not report "Criteria file not found"', output);
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
