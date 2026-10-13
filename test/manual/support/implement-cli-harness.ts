import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  buildPlanArtifactFilename,
  hashPlanArtifactSources,
  writePlanArtifactManifest,
} from '../../../src/shared/utils/plan-artifact';

export const projectRoot = path.resolve(__dirname, '../../..');
export const distMainPath = path.join(projectRoot, 'dist', 'main.js');

export type FakeClaudeMode = 'noop' | 'declare' | 'declareFormatted' | 'declareAndEdit' | 'writeEachPass' | 'deleteOrphan';

export type PlanOverrides = {
  steps?: string[];
  verification?: Record<string, unknown>;
  statusByFile?: Record<string, string>;
  extraFiles?: Record<string, string>;
};

export type ImplementHarness = {
  tempRoot: string;
  repoDir: string;
  binDir: string;
  homeDir: string;
  planPath: string;
  countFile: string;
  promptDir: string;
};

export type RunResult = { exitCode: number | null; output: string };

const fakeClaudeSource = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const here = __dirname;
if (process.argv[2] === '--version') {
  console.log('2.1.219 (Claude Code)');
  process.exit(0);
}
const { mode, countFile, promptDir } = JSON.parse(fs.readFileSync(path.join(here, 'scenario.json'), 'utf8'));
fs.appendFileSync(countFile, 'x\\n');
const n = fs.readFileSync(countFile, 'utf8').split('\\n').filter(Boolean).length;
const stdin = fs.readFileSync(0, 'utf8');
fs.writeFileSync(path.join(promptDir, n + '.txt'), process.argv.slice(2).join('\\n') + '\\n' + stdin);
const emit = (message) => console.log(JSON.stringify(message));
const toolUse = (name, file) => emit({
  type: 'assistant',
  message: { content: [{ type: 'tool_use', name, input: { file_path: path.resolve(file) } }] },
});
const result = (text) => emit({
  type: 'result', subtype: 'success', is_error: false, result: text, session_id: 's1', num_turns: 1,
});
let text = 'done';
if (mode === 'writeEachPass' && n > 1) {
  fs.writeFileSync('extra-' + n + '.ts', 'export {};\\n');
  toolUse('Write', 'extra-' + n + '.ts');
}
if (mode === 'deleteOrphan' && n === 1) {
  fs.rmSync('src/orphan.ts', { force: true });
}
if (mode === 'declare' && n === 2) {
  text = 'All good.\\nNO-CHANGE: src/a.ts\\n- NO-CHANGE: \`./src/b.ts\`\\nNO-CHANGE: src/other.ts';
}
if (mode === 'declareFormatted' && n === 2) {
  text = '**NO-CHANGE: src/a.ts**\\nNO-CHANGE: "src/b.ts".';
}
if (mode === 'declareAndEdit' && n === 2) {
  fs.appendFileSync('src/a.ts', '// edited\\n');
  toolUse('Edit', 'src/a.ts');
  text = 'NO-CHANGE: src/a.ts\\nNO-CHANGE: src/b.ts';
}
result(text);
`;

const buildWfConfig = (): string => [
  'module.exports = {',
  '  ai: [',
  "    { provider: 'anthropic', model: 'claude-sonnet-4-6', default: true, apiKey: 'test-key' },",
  '  ],',
  '  stages: {',
  "    implement: { provider: 'anthropic', backend: 'cli' },",
  '  },',
  '};',
  '',
].join('\n');

const git = (cwd: string, args: string[]): void => {
  spawnSync('git', args, { cwd, stdio: 'pipe' });
};

const initRepo = (repoDir: string, plannedFiles: string[], extraFiles: Record<string, string> = {}): void => {
  git(repoDir, ['init']);
  git(repoDir, ['config', 'user.email', 'test@test.com']);
  git(repoDir, ['config', 'user.name', 'Test']);
  fs.writeFileSync(path.join(repoDir, 'wf.config.js'), buildWfConfig(), 'utf-8');
  fs.writeFileSync(path.join(repoDir, 'README.md'), '# Smoke\n', 'utf-8');
  fs.mkdirSync(path.join(repoDir, 'src'), { recursive: true });
  for (const file of plannedFiles) fs.writeFileSync(path.join(repoDir, file), 'export {};\n', 'utf-8');
  for (const [file, content] of Object.entries(extraFiles)) fs.writeFileSync(path.join(repoDir, file), content, 'utf-8');
  git(repoDir, ['add', '.']);
  git(repoDir, ['commit', '-m', 'init']);
};

const buildAffectedFiles = (
  repoName: string, plannedFiles: string[], statusByFile: Record<string, string> = {},
): Array<string | { filePath: string; status: string }> =>
  plannedFiles.map(file => statusByFile[file]
    ? { filePath: `${repoName}/${file}`, status: statusByFile[file] }
    : `${repoName}/${file}`);

const buildPlanJson = (
  repoName: string, plannedFiles: string[], overrides: PlanOverrides = {},
): string => JSON.stringify({
  action: 'fix',
  summary: 'smoke test plan',
  steps: overrides.steps ?? ['step 1'],
  estimatedComplexity: 'low',
  affectedFiles: buildAffectedFiles(repoName, plannedFiles, overrides.statusByFile),
  affectedRepositories: [repoName],
  risks: [],
  ...(overrides.verification ? { verification: overrides.verification } : {}),
});

const writePlanArtifact = (
  homeDir: string, repoName: string, plannedFiles: string[], overrides: PlanOverrides = {},
): string => {
  const sourceStem = 'source';
  const hash = hashPlanArtifactSources([sourceStem]);
  const planPath = path.join(homeDir, '.wf', repoName, buildPlanArtifactFilename({ hash, action: 'fix', format: 'json' }));
  fs.mkdirSync(path.dirname(planPath), { recursive: true });
  fs.writeFileSync(planPath, buildPlanJson(repoName, plannedFiles, overrides), 'utf-8');
  writePlanArtifactManifest({
    artifactPath: planPath, action: 'fix', createdAt: new Date().toISOString(),
    hash, format: 'json', sourceKind: 'custom', sourceName: sourceStem,
  });
  return planPath;
};

const homeStateDirs = (homeDir: string): string[] => [
  path.join(homeDir, '.wf', 'logs'),
  path.join(homeDir, '.wf', 'state'),
];

const createLayout = (tempRoot: string): Omit<ImplementHarness, 'planPath'> => {
  const layout = {
    tempRoot,
    repoDir: path.join(tempRoot, 'repo'),
    binDir: path.join(tempRoot, 'bin'),
    homeDir: path.join(tempRoot, 'home'),
    promptDir: path.join(tempRoot, 'prompts'),
    countFile: path.join(tempRoot, 'spawn-count.txt'),
  };
  for (const dir of [layout.repoDir, layout.binDir, layout.promptDir, ...homeStateDirs(layout.homeDir)]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(layout.countFile, '');
  return layout;
};

const installFakeClaude = (layout: Omit<ImplementHarness, 'planPath'>, mode: FakeClaudeMode): void => {
  const { binDir, countFile, promptDir } = layout;
  fs.writeFileSync(path.join(binDir, 'scenario.json'), JSON.stringify({ mode, countFile, promptDir }));
  fs.writeFileSync(path.join(binDir, 'claude'), fakeClaudeSource, { mode: 0o755 });
};

export const setupImplementHarness = (
  prefix: string, mode: FakeClaudeMode, plannedFiles: string[], overrides: PlanOverrides = {},
): ImplementHarness => {
  const layout = createLayout(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  installFakeClaude(layout, mode);
  initRepo(layout.repoDir, plannedFiles, overrides.extraFiles);
  const planPath = writePlanArtifact(layout.homeDir, path.basename(layout.repoDir), plannedFiles, overrides);
  return { ...layout, planPath };
};

export const rewritePlan = (harness: ImplementHarness, plannedFiles: string[], overrides: PlanOverrides): void => {
  fs.writeFileSync(harness.planPath, buildPlanJson(path.basename(harness.repoDir), plannedFiles, overrides), 'utf-8');
};

export const runImplement = (harness: ImplementHarness, timeoutMs = 60_000): RunResult => {
  const env = {
    ...process.env,
    HOME: harness.homeDir,
    PATH: `${harness.binDir}${path.delimiter}${process.env['PATH'] ?? ''}`,
  };
  const result = spawnSync(
    'node',
    [distMainPath, 'issue:implement', harness.planPath, '--silent', '--no-branch', '--skip-install'],
    { cwd: harness.repoDir, env, encoding: 'utf-8', maxBuffer: 1024 * 1024 * 10, timeout: timeoutMs },
  );
  return { exitCode: result.status, output: `${result.stdout ?? ''}\n${result.stderr ?? ''}` };
};

export const countSpawns = (harness: ImplementHarness): number =>
  fs.readFileSync(harness.countFile, 'utf-8').split('\n').filter(Boolean).length;

export const readPrompt = (harness: ImplementHarness, callNumber: number): string => {
  const promptPath = path.join(harness.promptDir, `${callNumber}.txt`);
  return fs.existsSync(promptPath) ? fs.readFileSync(promptPath, 'utf-8') : '';
};

export const cleanupHarness = (harness: ImplementHarness): void => {
  fs.rmSync(harness.tempRoot, { recursive: true, force: true });
};
