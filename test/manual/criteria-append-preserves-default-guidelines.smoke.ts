/**
 * Manual smoke test: --criteria appends to the default rubric instead of replacing it
 *
 * Run: nr test:manual -- criteria-append-preserves-default-guidelines.smoke
 *
 * Scenario: The user supplies `--criteria <file>` (not `--replace-criteria`).
 * The review prompt must contain both a built-in default guideline category
 * and the custom file's guideline text, proving the append path is genuinely
 * additive rather than accidentally replacing the defaults. A second run with
 * `--replace-criteria` against the same file must drop the default guideline
 * for the same input that append mode preserves it for.
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
 *   1. Run A (`--criteria <path>`): the captured prompt contains the custom
 *      guideline text.
 *   2. Run A also contains a built-in default guideline string verbatim from
 *      defaultReviewGuidelines in src/workflows/stages/review-stage.service.ts
 *      — proving defaults were not dropped.
 *   3. Run B (`--replace-criteria <path>`, same file, fresh temp repo):
 *      the captured prompt contains the custom guideline text from step 1.
 *   4. Run B's prompt does not contain the built-in default guideline string
 *      checked in step 2 — proving replace mode drops defaults for the same
 *      input that append mode preserves them for.
 *   5. Both runs exit 0.
 *
 * Wire up: build the project first, create two isolated temp git repos (one
 * per run) each with a real diff, write wf.config.js for Claude CLI review,
 * and place a fake `claude` executable ahead of PATH per run that logs
 * captured stdin to disk and returns a valid CodeReview JSON result. Run the
 * compiled CLI via node dist/main.js issue:review -r <repo> --criteria <path>
 * -s for run A and --replace-criteria <path> for run B against the same
 * criteria file content, and diff the two captured prompts for the
 * presence/absence asserted above.
 * Teardown: remove both temp repos, fake bin directories, isolated WF_HOME
 * directories, and prompt logs; restore environment variables.
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

const CRITERIA_MARKDOWN = [
  '## Custom rule',
  '',
  '- Every deferral carries TODO(WBP-####) in code, with a real assigned ticket.',
  '',
].join('\n');

const CUSTOM_GUIDELINE = 'Custom rule: Every deferral carries TODO(WBP-####) in code, with a real assigned ticket.';
const DEFAULT_GUIDELINE = 'Security: Check for exposed secrets, injection vectors, missing auth/authz guards, and unsafe deserialization.';

const buildFakeClaudeScript = (invocationLogPath: string, promptsLogPath: string): string => `#!/usr/bin/env node
const fs = require('fs');
const args = process.argv.slice(2);

fs.appendFileSync(${JSON.stringify(invocationLogPath)}, JSON.stringify(args) + '\\n');

let input = '';
process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('end', () => {
  fs.appendFileSync(${JSON.stringify(promptsLogPath)}, input + '\\n---\\n');

  console.log(JSON.stringify({
    type: 'result', subtype: 'success', result: ${JSON.stringify(validReviewJson)}, session_id: 'sess-append-1',
  }));
});
`;

const runReview = (tempRoot: string, criteriaFlag: '--criteria' | '--replace-criteria', criteriaPath: string): { status: number | null; firstPrompt: string } => {
  const wfHomeDir = path.join(tempRoot, 'wfhome');
  const repoDir = path.join(tempRoot, 'repo');
  const binDir = path.join(tempRoot, 'bin');
  const configPath = path.join(repoDir, 'wf.config.js');
  const claudeScriptPath = path.join(binDir, 'claude');
  const invocationLogPath = path.join(tempRoot, 'invocations.log');
  const promptsLogPath = path.join(tempRoot, 'invocations.prompts.log');
  const trackedFilePath = path.join(repoDir, 'src.ts');

  fs.mkdirSync(repoDir, { recursive: true });
  fs.mkdirSync(binDir, { recursive: true });
  fs.mkdirSync(path.join(wfHomeDir, 'logs'), { recursive: true });
  fs.mkdirSync(path.join(wfHomeDir, 'state'), { recursive: true });

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
    [distMainPath, 'issue:review', '-r', repoDir, criteriaFlag, criteriaPath, '-s'],
    { cwd: repoDir, env, encoding: 'utf-8', maxBuffer: 1024 * 1024 * 10 }
  ) as SpawnResult;

  const prompts = fs.existsSync(promptsLogPath)
    ? fs.readFileSync(promptsLogPath, 'utf-8').split('\n---\n').filter(Boolean)
    : [];

  return { status: result.status, firstPrompt: prompts[0] ?? '' };
};

async function main(): Promise<void> {
  if (fs.existsSync(distMainPath)) {
    pass('dist/main.js exists');
  } else {
    fail('dist/main.js must exist before running this smoke test', 'Run `yarn build` first.');
    process.exit(1);
  }

  const tempRootA = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-criteria-append-'));
  const tempRootB = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-criteria-replace-'));
  const criteriaPathA = path.join(tempRootA, 'criteria.md');
  const criteriaPathB = path.join(tempRootB, 'criteria.md');

  try {
    fs.writeFileSync(criteriaPathA, CRITERIA_MARKDOWN, 'utf-8');
    fs.writeFileSync(criteriaPathB, CRITERIA_MARKDOWN, 'utf-8');

    const runA = runReview(tempRootA, '--criteria', criteriaPathA);
    const runB = runReview(tempRootB, '--replace-criteria', criteriaPathB);

    if (runA.status === 0) {
      pass('run A (--criteria) exits 0');
    } else {
      fail('run A (--criteria) should exit 0', runA.firstPrompt);
    }

    if (runB.status === 0) {
      pass('run B (--replace-criteria) exits 0');
    } else {
      fail('run B (--replace-criteria) should exit 0', runB.firstPrompt);
    }

    if (runA.firstPrompt.includes(CUSTOM_GUIDELINE)) {
      pass('run A prompt contains the custom guideline text');
    } else {
      fail('run A prompt should contain the custom guideline text', runA.firstPrompt.slice(0, 800));
    }

    if (runA.firstPrompt.includes(DEFAULT_GUIDELINE)) {
      pass('run A prompt still contains a built-in default guideline (append preserves defaults)');
    } else {
      fail('run A prompt should still contain a built-in default guideline', runA.firstPrompt.slice(0, 800));
    }

    if (runB.firstPrompt.includes(CUSTOM_GUIDELINE)) {
      pass('run B prompt contains the custom guideline text');
    } else {
      fail('run B prompt should contain the custom guideline text', runB.firstPrompt.slice(0, 800));
    }

    const runBDroppedDefault = !runB.firstPrompt.includes(DEFAULT_GUIDELINE);

    if (runBDroppedDefault) {
      pass('run B prompt does not contain the built-in default guideline (replace drops defaults)');
    } else {
      fail('run B prompt should not contain the built-in default guideline', runB.firstPrompt.slice(0, 800));
    }
  } finally {
    fs.rmSync(tempRootA, { recursive: true, force: true });
    fs.rmSync(tempRootB, { recursive: true, force: true });
  }

  console.log(chalk.bold(`\nSummary: ${counts.passed} passed, ${counts.failed} failed`));
  process.exit(counts.failed > 0 ? 1 : 0);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
