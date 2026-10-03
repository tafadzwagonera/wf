/**
 * Manual smoke test: issue:review criteria resolves bare filenames from the artifact namespace
 *
 * Run: nr test:manual issue-review-criteria-artifact-resolution.smoke.ts
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
  invocationLogPath: string;
  promptsLogPath: string;
  trackedFilePath: string;
  artifactCriteriaPath: string;
  decoyCriteriaPath: string;
};

type ScenarioData = {
  result: SpawnResult;
  output: string;
  firstPrompt: string;
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

function buildCriteriaScriptBody(invocationLogPath: string, promptsLogPath: string): string {
  const invocP = JSON.stringify(invocationLogPath);
  const promP = JSON.stringify(promptsLogPath);
  return `const fs = require('fs');
const args = process.argv.slice(2);
fs.appendFileSync(${invocP}, JSON.stringify(args) + '\\n');
let input = '';
process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('end', () => {
  fs.appendFileSync(${promP}, input + '\\n---\\n');
  const invocationCount = fs.readFileSync(${invocP}, 'utf-8').trim().split('\\n').filter(Boolean).length;
  if (invocationCount === 1) console.log(JSON.stringify({type:'result',subtype:'success',result:${JSON.stringify(validReviewJson)},session_id:'sess-criteria-1'}));
  else console.log(JSON.stringify({type:'result',subtype:'success',result:'Review summary: looks good.',session_id:'sess-criteria-1'}));
});`;
}

const buildFakeClaudeScript = (invocationLogPath: string, promptsLogPath: string): string =>
  `#!/usr/bin/env node\n${buildCriteriaScriptBody(invocationLogPath, promptsLogPath)}`;

type BasicCriteriaPaths = Omit<Paths, 'artifactCriteriaPath' | 'decoyCriteriaPath'>;

function buildBasicCriteriaPaths(tempRoot: string): BasicCriteriaPaths {
  const wfHomeDir = path.join(tempRoot, 'wfhome');
  const repoDir = path.join(tempRoot, 'repo');
  const binDir = path.join(tempRoot, 'bin');
  return {
    wfHomeDir,
    repoDir,
    binDir,
    configPath: path.join(repoDir, 'wf.config.js'),
    claudeScriptPath: path.join(binDir, 'claude'),
    invocationLogPath: path.join(tempRoot, 'invocations.log'),
    promptsLogPath: path.join(tempRoot, 'invocations.prompts.log'),
    trackedFilePath: path.join(repoDir, 'src.ts'),
  };
}

function buildCriteriaPaths(wfHomeDir: string, repoDir: string): Pick<Paths, 'artifactCriteriaPath' | 'decoyCriteriaPath'> {
  const repoBasename = path.basename(repoDir);
  return {
    artifactCriteriaPath: path.join(wfHomeDir, repoBasename, 'review-guidelines.md'),
    decoyCriteriaPath: path.join(repoDir, 'review-guidelines.md'),
  };
}

function buildPaths(tempRoot: string): Paths {
  const basic = buildBasicCriteriaPaths(tempRoot);
  const criteria = buildCriteriaPaths(basic.wfHomeDir, basic.repoDir);
  return {
    ...basic,
    ...criteria,
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
  fs.mkdirSync(path.dirname(paths.artifactCriteriaPath), { recursive: true });
  fs.mkdirSync(path.join(paths.wfHomeDir, 'logs'), { recursive: true });
  fs.mkdirSync(path.join(paths.wfHomeDir, 'state'), { recursive: true });
  fs.writeFileSync(paths.artifactCriteriaPath, `- ${ARTIFACT_CRITERIA_TEXT}\n`, 'utf-8');
  fs.writeFileSync(paths.decoyCriteriaPath, `- ${DECOY_CRITERIA_TEXT}\n`, 'utf-8');
  setupGitRepo(paths.repoDir, paths.trackedFilePath);
  fs.writeFileSync(paths.configPath, buildConfigContent(), 'utf-8');
  writeExecutable(paths.claudeScriptPath, buildFakeClaudeScript(paths.invocationLogPath, paths.promptsLogPath));
}

function buildEnv(wfHomeDir: string, binDir: string): NodeJS.ProcessEnv {
  return { ...process.env, HOME: os.homedir(), WF_HOME: wfHomeDir, PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ''}`, WF_SKIP_CLI_VERSION_CHECK: '1' };
}

function runScenario(tempRoot: string): ScenarioData {
  const paths = buildPaths(tempRoot);
  setupFixtures(paths);
  const env = buildEnv(paths.wfHomeDir, paths.binDir);
  const result = spawnSync('node', [distMainPath, 'issue:review', '-r', paths.repoDir, '--criteria', 'review-guidelines.md', '-s'], { cwd: paths.repoDir, env, encoding: 'utf-8', maxBuffer: 1024 * 1024 * 10 }) as SpawnResult;
  const prompts = fs.existsSync(paths.promptsLogPath) ? fs.readFileSync(paths.promptsLogPath, 'utf-8').split('\n---\n').filter(Boolean) : [];
  return { result, output: `${result.stdout}\n${result.stderr}`, firstPrompt: prompts[0] ?? '' };
}

function checkDistExists(): void {
  if (!fs.existsSync(distMainPath)) {
    fail('dist/main.js must exist before running this smoke test', 'Run `yarn build` first.');
    process.exit(1);
  }
}

function checkExitsZero(result: SpawnResult, output: string): void {
  if (result.status === 0) pass('command exits 0');
  else fail('command should exit 0', output);
}

function checkArtifactCriteriaInPrompt(firstPrompt: string): void {
  if (firstPrompt.includes(ARTIFACT_CRITERIA_TEXT)) pass('review prompt includes artifact criteria text');
  else fail('review prompt should include artifact criteria text', firstPrompt.slice(0, 500));
}

function checkDecoyCriteriaAbsent(firstPrompt: string): void {
  if (firstPrompt.includes(DECOY_CRITERIA_TEXT)) fail('review prompt should not include cwd decoy criteria text', firstPrompt.slice(0, 500));
  else pass('review prompt does not include cwd decoy criteria text');
}

function checkNoCriteriaNotFound(output: string): void {
  if (output.includes('Criteria file not found')) fail('output should not report "Criteria file not found"', output);
  else pass('output does not report "Criteria file not found"');
}

function runChecks(data: ScenarioData): void {
  checkExitsZero(data.result, data.output);
  checkArtifactCriteriaInPrompt(data.firstPrompt);
  checkDecoyCriteriaAbsent(data.firstPrompt);
  checkNoCriteriaNotFound(data.output);
}

async function main(): Promise<void> {
  checkDistExists();
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-criteria-artifact-'));
  try {
    runChecks(runScenario(tempRoot));
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
  summarise(counts);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
