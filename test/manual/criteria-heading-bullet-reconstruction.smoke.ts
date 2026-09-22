/**
 * Manual smoke test: criteria markdown parsing reconstructs headed, unfragmented bullets
 *
 * Run: nr test:manual criteria-heading-bullet-reconstruction.smoke.ts
 *
 * Scenario: The user supplies a `--criteria` markdown file written in the
 * common style of `## Section` headers followed by bullets that wrap across
 * multiple physical lines (as real-world criteria files do). The parser must
 * prefix each guideline with its nearest heading and rejoin wrapped
 * continuation lines into the same guideline, instead of dropping headers and
 * emitting each wrapped line as its own fragment.
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
 *   1. The live review prompt contains the single, fully-reconstructed
 *      guideline string with the "Design fidelity: " prefix and both wrapped
 *      lines joined onto the first line.
 *   2. The prompt does not contain the orphan continuation fragment as its own
 *      standalone line (proves continuation lines were rejoined, not
 *      fragmented).
 *   3. The prompt contains the "Accessibility: " prefixed guideline (proves
 *      the second heading resets the section prefix instead of leaking
 *      "Design fidelity" onto it).
 *   4. The prompt does not contain a bare "## Design fidelity" or
 *      "## Accessibility" heading line (proves headers are consumed as
 *      context, not passed through verbatim).
 *   5. The command exits 0.
 *
 * Wire up: build the project first, create a temp git repo with a real diff,
 * write wf.config.js for Claude CLI review, and place a fake `claude`
 * executable ahead of PATH that logs captured stdin to disk and returns a
 * valid CodeReview JSON result. Write the criteria markdown file to a temp
 * path and run the compiled CLI via node dist/main.js rather than calling
 * parseCriteriaMarkdown directly — this test exists to catch dist/src drift
 * and prompt-assembly wiring that a unit test on the parser alone cannot.
 * Teardown: remove the temp repo, fake bin directory, isolated WF_HOME, and
 * prompt logs; restore environment variables.
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

type TestEnv = {
  repoDir: string;
  binDir: string;
  wfHomeDir: string;
  promptsLogPath: string;
  criteriaPath: string;
  claudeScriptPath: string;
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
  '## Design fidelity',
  '',
  '- Compare the implementation against the Figma frame visually, not token-by-token: correct',
  '  colour tokens can still land in the wrong order, direction, or angle. Check colours,',
  '  gradients/stripe direction, spacing, and typography scale against the frame.',
  '- Check the mobile frames separately.',
  '',
  '## Accessibility',
  '',
  '- Chase browser console accessibility warnings to resolution.',
  '',
].join('\n');

const RECONSTRUCTED_GUIDELINE
  = 'Design fidelity: Compare the implementation against the Figma frame visually, not token-by-token: correct '
    + 'colour tokens can still land in the wrong order, direction, or angle. Check colours, gradients/stripe direction, '
    + 'spacing, and typography scale against the frame.';
const ORPHAN_FRAGMENT = 'colour tokens can still land in the wrong order, direction, or angle. Check colours,';
const ACCESSIBILITY_GUIDELINE = 'Accessibility: Chase browser console accessibility warnings to resolution.';

const buildFakeClaudeScript = (invocationLogPath: string, promptsLogPath: string): string => `#!/usr/bin/env node
const fs = require('fs');
const args = process.argv.slice(2);

fs.appendFileSync(${JSON.stringify(invocationLogPath)}, JSON.stringify(args) + '\\n');

let input = '';
process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('end', () => {
  fs.appendFileSync(${JSON.stringify(promptsLogPath)}, input + '\\n---\\n');

  console.log(JSON.stringify({
    type: 'result', subtype: 'success', result: ${JSON.stringify(validReviewJson)}, session_id: 'sess-heading-1',
  }));
});
`;

function assertDistExists(): void {
  if (fs.existsSync(distMainPath)) {
    pass('dist/main.js exists');
    return;
  }
  fail('dist/main.js must exist before running this smoke test', 'Run `yarn build` first.');
  process.exit(1);
}

function createTestDirs(tempRoot: string): TestEnv {
  const wfHomeDir = path.join(tempRoot, 'wfhome');
  const repoDir = path.join(tempRoot, 'repo');
  const binDir = path.join(tempRoot, 'bin');
  fs.mkdirSync(repoDir, { recursive: true });
  fs.mkdirSync(binDir, { recursive: true });
  fs.mkdirSync(path.join(wfHomeDir, 'logs'), { recursive: true });
  fs.mkdirSync(path.join(wfHomeDir, 'state'), { recursive: true });
  return {
    repoDir, binDir, wfHomeDir,
    promptsLogPath: path.join(tempRoot, 'invocations.prompts.log'),
    criteriaPath: path.join(tempRoot, 'criteria.md'),
    claudeScriptPath: path.join(binDir, 'claude'),
  };
}

function setupGitRepo(repoDir: string): void {
  const gitEnv = {
    ...process.env,
    GIT_AUTHOR_NAME: 'wf',
    GIT_AUTHOR_EMAIL: 'wf@example.com',
    GIT_COMMITTER_NAME: 'wf',
    GIT_COMMITTER_EMAIL: 'wf@example.com',
  };
  const trackedFilePath = path.join(repoDir, 'src.ts');
  execFileSync('git', ['init', '-q'], { cwd: repoDir, env: gitEnv });
  fs.writeFileSync(trackedFilePath, 'line 1\nline 2\n', 'utf-8');
  execFileSync('git', ['add', 'src.ts'], { cwd: repoDir, env: gitEnv });
  execFileSync('git', ['commit', '-q', '-m', 'initial'], { cwd: repoDir, env: gitEnv });
  fs.writeFileSync(trackedFilePath, 'line 1\nline 2\nline 3 added\n', 'utf-8');
}

const WF_CONFIG_LINES = [
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

function writeWfConfig(repoDir: string): void {
  fs.writeFileSync(path.join(repoDir, 'wf.config.js'), WF_CONFIG_LINES, 'utf-8');
}

function runReviewCommand(env: TestEnv): SpawnResult {
  const spawnEnv = {
    ...process.env,
    HOME: os.homedir(),
    WF_HOME: env.wfHomeDir,
    PATH: `${env.binDir}${path.delimiter}${process.env.PATH ?? ''}`,
    WF_SKIP_CLI_VERSION_CHECK: '1',
  };
  return spawnSync(
    'node',
    [distMainPath, 'issue:review', '-r', env.repoDir, '--criteria', env.criteriaPath, '-s'],
    { cwd: env.repoDir, env: spawnEnv, encoding: 'utf-8', maxBuffer: 1024 * 1024 * 10 }
  ) as SpawnResult;
}

function readPrompts(promptsLogPath: string): string[] {
  if (!fs.existsSync(promptsLogPath)) return [];
  return fs.readFileSync(promptsLogPath, 'utf-8').split('\n---\n').filter(Boolean);
}

const checkStatusExit = (result: SpawnResult, output: string): void => {
  if (result.status === 0) pass('command exits 0');
  else fail('command should exit 0', output);
};

const checkReconstructedGuideline = (firstPrompt: string): void => {
  if (firstPrompt.includes(RECONSTRUCTED_GUIDELINE)) {
    pass('review prompt contains the fully-reconstructed, section-prefixed guideline');
  } else {
    fail('review prompt should contain the fully-reconstructed guideline', firstPrompt.slice(0, 800));
  }
};

const checkOrphanFragment = (firstPrompt: string): void => {
  const promptLines = firstPrompt.split('\n').map(line => line.replace(/^\d+\.\s+/, '').trim());
  if (promptLines.every(line => line !== ORPHAN_FRAGMENT)) {
    pass('review prompt does not contain the continuation line as an orphan fragment');
  } else {
    fail(
      'review prompt should not contain the continuation line as its own fragment',
      firstPrompt.slice(0, 800),
    );
  }
};

const checkAccessibilityGuideline = (firstPrompt: string): void => {
  if (firstPrompt.includes(ACCESSIBILITY_GUIDELINE)) {
    pass('review prompt contains the second section\'s correctly-prefixed guideline');
  } else {
    fail('review prompt should contain the Accessibility-prefixed guideline', firstPrompt.slice(0, 800));
  }
};

const checkNoBareHeadings = (firstPrompt: string): void => {
  const noBareHeading = firstPrompt.split('\n').every(
    line => line.trim() !== '## Design fidelity' && line.trim() !== '## Accessibility',
  );
  if (noBareHeading) pass('review prompt does not contain a bare markdown heading line');
  else fail('review prompt should not contain a bare markdown heading line', firstPrompt.slice(0, 800));
};

function checkHeadingReconstructionResults(result: SpawnResult, firstPrompt: string): void {
  const output = `${result.stdout}\n${result.stderr}`;
  checkStatusExit(result, output);
  checkReconstructedGuideline(firstPrompt);
  checkOrphanFragment(firstPrompt);
  checkAccessibilityGuideline(firstPrompt);
  checkNoBareHeadings(firstPrompt);
}

function runTestInDir(tempRoot: string): void {
  const env = createTestDirs(tempRoot);
  fs.writeFileSync(env.criteriaPath, CRITERIA_MARKDOWN, 'utf-8');
  setupGitRepo(env.repoDir);
  writeWfConfig(env.repoDir);
  const fakeScript = buildFakeClaudeScript(path.join(tempRoot, 'invocations.log'), env.promptsLogPath);
  writeExecutable(env.claudeScriptPath, fakeScript);
  const result = runReviewCommand(env);
  checkHeadingReconstructionResults(result, readPrompts(env.promptsLogPath)[0] ?? '');
}

async function main(): Promise<void> {
  console.log(chalk.bold.cyan('\ncriteria-heading-bullet-reconstruction smoke test\n'));
  assertDistExists();
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-criteria-heading-'));
  try {
    runTestInDir(tempRoot);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
  summarise(counts);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
