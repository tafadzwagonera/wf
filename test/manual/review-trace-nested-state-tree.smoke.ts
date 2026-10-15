/**
 * Manual smoke test: issue:review renders nested state transitions from entry-array and legacy record traces
 *
 * Run: nr test:manual review-trace-nested-state-tree.smoke
 *
 * Scenario: A user runs `node dist/main.js issue:review -r <repo>` against a repo
 * with an uncommitted edit. A fake `claude` returns a review whose
 * stateTransition nests a child frame under a parent frame, once with
 * entry-array captured/changes and once with the legacy record shape.
 *
 * Config under test:
 *   ai: [{ provider: 'anthropic', model: 'claude-sonnet-4-6', default: true, apiKey: 'k' }]
 *   stages: { review: { provider: 'anthropic', backend: 'cli', model: 'claude-sonnet-4-6' } }
 *
 * Verify:
 *   1. Both runs exit 0.
 *   2. The child frame renders indented deeper than the parent frame.
 *   3. Captured and changed variable names render, and no `undefined` text appears.
 *   4. Legacy record input renders the same tree as entry-array input.
 *   5. The prompt sent to claude contains the nesting guidance and entry-array example.
 *   6. The --json-schema argv describes captured/changes as arrays of named entries.
 *
 * Wire up: requires dist/main.js (`yarn build`). Temp git repo with one
 * uncommitted edit, wf.config.js, fake `claude` ahead of PATH, isolated WF_HOME.
 * Teardown: remove the temp directory.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { createReporter, summarise } from './support/reporter';

const projectRoot = path.resolve(__dirname, '../..');
const distMainPath = path.join(projectRoot, 'dist', 'main.js');
const { counts, pass, fail } = createReporter();

const entryArrayStep = {
  frame: 'runService()',
  captured: [{ name: 'depConfig', value: 'loaded' }],
  changes: [{ name: 'serviceState', before: 'idle', after: 'active' }],
  children: [
    {
      frame: 'helperTransform()',
      captured: [],
      changes: [{ name: 'transformResult', after: 'done' }],
      children: [],
    },
  ],
};

const legacyStep = {
  frame: 'runService()',
  captured: { depConfig: 'loaded' },
  changes: { serviceState: { before: 'idle', after: 'active' } },
  children: [
    {
      frame: 'helperTransform()',
      changes: { transformResult: { after: 'done' } },
      children: [],
    },
  ],
};

const buildReviewJson = (step: unknown): string =>
  JSON.stringify({
    summary: 'Nested trace smoke review.',
    issues: [],
    traceProvenance: 'evidence-based',
    callStack: [{ frame: 'runService()', children: [{ frame: 'helperTransform()', children: [] }] }],
    stateTransition: { from: 'runService()', to: 'helperTransform()', steps: [step] },
    suggestions: [],
    approved: true,
  });

const buildFakeClaude = (binDir: string): string => `#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
let input = '';
process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('end', () => {
  const promptFile = path.join(${JSON.stringify(binDir)}, 'prompt.txt');
  if (!fs.existsSync(promptFile)) {
    fs.writeFileSync(promptFile, input);
    fs.writeFileSync(path.join(${JSON.stringify(binDir)}, 'argv.json'), JSON.stringify(process.argv.slice(2)));
  }
  const payload = process.env.FAKE_REVIEW_JSON;
  console.log(JSON.stringify({ type: 'result', subtype: 'success', result: payload, session_id: 'sess-nested-1' }));
});
`;

const stripAnsi = (text: string): string => text.replaceAll(new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g'), '');

const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: 'wf',
  GIT_AUTHOR_EMAIL: 'wf@example.com',
  GIT_COMMITTER_NAME: 'wf',
  GIT_COMMITTER_EMAIL: 'wf@example.com',
};

const CONFIG_CONTENT = [
  'module.exports = {',
  "  ai: [{ provider: 'anthropic', model: 'claude-sonnet-4-6', default: true, apiKey: 'test-key' }],",
  "  stages: { review: { provider: 'anthropic', backend: 'cli', model: 'claude-sonnet-4-6' } },",
  '};',
  '',
].join('\n');

function setupRepo(repoDir: string): void {
  fs.mkdirSync(repoDir, { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: repoDir, env: gitEnv });
  const file = path.join(repoDir, 'service.ts');
  fs.writeFileSync(file, 'export function runService() {\n  return 1;\n}\n', 'utf-8');
  execFileSync('git', ['add', 'service.ts'], { cwd: repoDir, env: gitEnv });
  execFileSync('git', ['commit', '-q', '-m', 'initial'], { cwd: repoDir, env: gitEnv });
  fs.writeFileSync(file, 'export function runService() {\n  return helperTransform();\n}\nfunction helperTransform() {\n  return 2;\n}\n', 'utf-8');
  fs.writeFileSync(path.join(repoDir, 'wf.config.js'), CONFIG_CONTENT, 'utf-8');
}

function resetRun(root: string): void {
  fs.rmSync(path.join(root, 'bin', 'prompt.txt'), { force: true });
  fs.rmSync(path.join(root, 'wfhome'), { recursive: true, force: true });
  fs.mkdirSync(path.join(root, 'wfhome', 'logs'), { recursive: true });
  fs.mkdirSync(path.join(root, 'wfhome', 'state'), { recursive: true });
}

function buildEnv(root: string, reviewJson: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    WF_HOME: path.join(root, 'wfhome'),
    PATH: `${path.join(root, 'bin')}${path.delimiter}${process.env.PATH ?? ''}`,
    WF_SKIP_CLI_VERSION_CHECK: '1',
    FAKE_REVIEW_JSON: reviewJson,
  };
}

function runReview(root: string, reviewJson: string): { status: number | null; output: string } {
  const repoDir = path.join(root, 'repo');
  resetRun(root);
  const result = spawnSync('node', [distMainPath, 'issue:review', '-r', repoDir, '--skip-verification'], {
    cwd: repoDir, env: buildEnv(root, reviewJson), encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024,
  });
  return { status: result.status, output: stripAnsi(`${result.stdout ?? ''}\n${result.stderr ?? ''}`) };
}

const indentOf = (output: string, frame: string): number => {
  const line = output.split('\n').find(l => l.includes(`─ ${frame}`) && l.includes('State') === false);
  return line ? line.indexOf(frame) : -1;
};

function stateSection(output: string): string {
  const start = output.indexOf('State Transition');
  return start === -1 ? '' : output.slice(start);
}

function checkRender(label: string, run: { status: number | null; output: string }): string {
  if (run.status === 0) pass(`${label}: exits 0`);
  else fail(`${label}: should exit 0`, run.output.slice(-800));
  const section = stateSection(run.output);
  const parent = indentOf(section, 'runService()');
  const child = indentOf(section, 'helperTransform()');
  if (parent >= 0 && child > parent) pass(`${label}: child frame nested under parent`);
  else fail(`${label}: child frame should be indented deeper`, `parent=${parent} child=${child}\n${section.slice(0, 800)}`);
  const names = ['depConfig', 'serviceState', 'transformResult'];
  if (names.every(n => section.includes(n))) pass(`${label}: variable names render`);
  else fail(`${label}: variable names missing`, section.slice(0, 800));
  if (section.includes('undefined')) fail(`${label}: output contains "undefined"`, section.slice(0, 800));
  else pass(`${label}: no "undefined" in output`);
  return section;
}

function readIfExists(file: string): string {
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf-8') : '';
}

function checkPrompt(binDir: string): void {
  const prompt = readIfExists(path.join(binDir, 'prompt.txt'));
  const required = ['mirror the callStack nesting', '"captured":[{"name":"dep"', '"changes":[{"name":"dep"'];
  for (const needle of required) {
    if (prompt.includes(needle)) pass(`prompt contains ${needle}`);
    else fail(`prompt should contain ${needle}`, prompt.slice(0, 300));
  }
}

function schemaSlice(schemaText: string, key: string): string {
  const index = schemaText.indexOf(`"${key}"`);
  return index === -1 ? '' : schemaText.slice(index, index + 400);
}

function checkSchema(binDir: string): void {
  const argvText = readIfExists(path.join(binDir, 'argv.json'));
  const argv: string[] = argvText ? JSON.parse(argvText) : [];
  const schemaText = argv[argv.indexOf('--json-schema') + 1] ?? '';
  const captured = schemaSlice(schemaText, 'captured');
  const changes = schemaSlice(schemaText, 'changes');
  if (captured.includes('"type":"array"') && captured.includes('"name"')) pass('schema: captured is an array of named entries');
  else fail('schema: captured should be an array of named entries', captured);
  if (changes.includes('"type":"array"') && changes.includes('"before"')) pass('schema: changes is an array of named entries');
  else fail('schema: changes should be an array of named entries', changes);
}

function checkPromptAndSchema(root: string): void {
  checkPrompt(path.join(root, 'bin'));
  checkSchema(path.join(root, 'bin'));
}

function checkParity(entrySection: string, legacySection: string): void {
  if (entrySection !== '' && entrySection === legacySection) pass('legacy record renders identically to entry arrays');
  else fail('legacy record should render identically to entry arrays', `--- entry\n${entrySection}\n--- legacy\n${legacySection}`);
}

function runScenarios(root: string): void {
  fs.mkdirSync(path.join(root, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(root, 'bin', 'claude'), buildFakeClaude(path.join(root, 'bin')), { mode: 0o755 });
  setupRepo(path.join(root, 'repo'));
  const entrySection = checkRender('entry-array', runReview(root, buildReviewJson(entryArrayStep)));
  checkPromptAndSchema(root);
  const legacySection = checkRender('legacy-record', runReview(root, buildReviewJson(legacyStep)));
  checkParity(entrySection, legacySection);
}

function main(): void {
  if (!fs.existsSync(distMainPath)) {
    fail('dist/main.js must exist', 'Run `yarn build` first.');
    process.exit(1);
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-nested-trace-'));
  try {
    runScenarios(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
  summarise(counts);
}

main();
