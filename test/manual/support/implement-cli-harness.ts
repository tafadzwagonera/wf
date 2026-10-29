import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  buildPlanArtifactFilename,
  hashPlanArtifactSources,
  writePlanArtifactManifest,
} from '../../../src/common/utils/plan-artifact';

export const projectRoot = path.resolve(__dirname, '../../..');
export const distMainPath = path.join(projectRoot, 'dist', 'main.js');

export type FakeClaudeMode
  = | 'noop' | 'declare' | 'declareFormatted' | 'declareAndEdit' | 'writeEachPass' | 'deleteOrphan'
    | 'assessorProbe' | 'assessorRenumber' | 'assessorOmitOne' | 'assessorPullOutOfScope' | 'intentFidelity'
    | 'planProblem' | 'planProblemMalformed' | 'untrackedFidelity' | 'interleavedToolResults';

export type PlanOverrides = {
  steps?: string[];
  verification?: Record<string, unknown>;
  statusByFile?: Record<string, string>;
  extraFiles?: Record<string, string>;
  stepVerification?: Record<string, unknown>;
  estimatedComplexity?: string;
};

export type ImplementHarness = {
  tempRoot: string;
  repoDir: string;
  binDir: string;
  homeDir: string;
  planPath: string;
  countFile: string;
  promptDir: string;
  envReportFile: string;
};

export type RunResult = { exitCode: number | null; output: string };

export type EnvReportEntry = { hasAnthropicApiKey: boolean; hasPath: boolean };

const fakeClaudeSource = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const here = __dirname;
if (process.argv[2] === '--version') {
  console.log('2.1.219 (Claude Code)');
  process.exit(0);
}
const { mode, countFile, promptDir, envReportFile } = JSON.parse(fs.readFileSync(path.join(here, 'scenario.json'), 'utf8'));
fs.appendFileSync(envReportFile, JSON.stringify({
  hasAnthropicApiKey: Boolean(process.env.ANTHROPIC_API_KEY), hasPath: Boolean(process.env.PATH),
}) + '\\n');
fs.appendFileSync(countFile, 'x\\n');
const n = fs.readFileSync(countFile, 'utf8').split('\\n').filter(Boolean).length;
const stdin = fs.readFileSync(0, 'utf8');
const fullPrompt = process.argv.slice(2).join('\\n') + '\\n' + stdin;
fs.writeFileSync(path.join(promptDir, n + '.txt'), fullPrompt);
const emit = (message) => console.log(JSON.stringify(message));
const toolUse = (name, file) => emit({
  type: 'assistant',
  message: { content: [{ type: 'tool_use', name, input: { file_path: path.resolve(file) } }] },
});
const result = (text) => emit({
  type: 'result', subtype: 'success', is_error: false, result: text, session_id: 's1', num_turns: 1,
});
const respondAsAssessor = () => {
  const seenFile = path.join(here, 'assessor-seen.txt');
  fs.appendFileSync(seenFile, 'x');
  const call = fs.readFileSync(seenFile, 'utf8').length;
  const tags = [...fullPrompt.matchAll(/\\[Plan step (\\d+)\\]/g)].map(match => Number(match[1]));
  const done = index => ({ index, status: 'done' });
  const pending = [5, 6, 8, 9];
  const firstRound = tags.map(index => (
    pending.includes(index) ? { index, status: 'not-done', missing: 'still missing' } : done(index)
  ));
  const secondRound = mode === 'assessorOmitOne' && call === 2 ? tags.filter(index => index !== 9).map(done) : tags.map(done);
  const laterRound = mode === 'assessorRenumber' ? [0, 1, 2, 3].map(done) : secondRound;
  const planProblemRound = tags.map(index => (
    call === 1 ? { index, status: 'not-done', missing: 'still missing' } : done(index)
  ));
  const statuses = mode.startsWith('planProblem')
    ? planProblemRound
    : mode === 'assessorPullOutOfScope' ? [done(9)] : call === 1 ? firstRound : laterRound;
  const checklistPaths = [
    ...[...fullPrompt.matchAll(/^- changed: .* -- (\\S+)\\x60$/gm)].map(match => match[1]),
    ...[...fullPrompt.matchAll(/^- untracked: read the file (\\S+)$/gm)].map(match => match[1]),
  ];
  const structuredOutput = fullPrompt.includes('## Mandatory inspection checklist')
    ? { statuses, inspectedPaths: checklistPaths }
    : { statuses };
  emit({
    type: 'result', subtype: 'success', is_error: false, result: '', structured_output: structuredOutput,
    session_id: 's1', num_turns: 1,
  });
};
const isAssessorPrompt = fullPrompt.includes('Index each step ONLY by its [Plan step N] tag');
const respondAsImplementer = () => {
let text = 'done';
if (mode === 'planProblem' && n === 1) {
  fs.appendFileSync('src/a.ts', '// implemented\\n');
  toolUse('Edit', 'src/a.ts');
  text = 'Done.\\nPLAN-PROBLEM: 1 | resolver differs from plan text | matched the runtime resolver';
}
if (mode === 'planProblemMalformed' && n === 1) {
  fs.appendFileSync('src/a.ts', '// implemented\\n');
  toolUse('Edit', 'src/a.ts');
  text = 'Done.\\nPLAN-PROBLEM: 1 | only two parts';
}
if (mode === 'intentFidelity' && n === 1) {
  fs.appendFileSync('src/a.ts', '// implemented\\n');
  toolUse('Edit', 'src/a.ts');
}
if (mode === 'untrackedFidelity' && n === 1) {
  fs.appendFileSync('src/a.ts', '// implemented\\n');
  toolUse('Edit', 'src/a.ts');
  fs.mkdirSync('scripts', { recursive: true });
  fs.writeFileSync('scripts/new-tool.sh', '#!/bin/sh\\nset -eu\\n');
  toolUse('Write', 'scripts/new-tool.sh');
}
if (mode === 'interleavedToolResults' && n === 1) {
  const bash = (id, command) => emit({
    type: 'assistant',
    message: { content: [{ type: 'tool_use', id, name: 'Bash', input: { command } }] },
  });
  const toolResult = (toolUseId, content, isError) => emit({
    type: 'user',
    message: { content: [{ type: 'tool_result', tool_use_id: toolUseId, content, is_error: isError }] },
  });
  bash('b1', 'bash -c "broken"');
  bash('b2', 'git status');
  toolResult('b1', 'syntax error near unexpected token', true);
  toolResult('b2', 'exit code 0', false);
}
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
};
const isFidelityPrompt = fullPrompt.includes('## Plan step') && fullPrompt.includes('## Your task');
const usesFidelityStub = mode === 'intentFidelity' || mode === 'untrackedFidelity' || mode.startsWith('planProblem');
if (usesFidelityStub && isFidelityPrompt) result('{"findings":[]}');
else if ((mode.startsWith('assessor') || usesFidelityStub) && isAssessorPrompt) respondAsAssessor();
else respondAsImplementer();
`;

const buildWfConfig = (stepVerification?: Record<string, unknown>): string => [
  'module.exports = {',
  '  ai: [',
  "    { provider: 'anthropic', model: 'claude-sonnet-4-6', default: true, apiKey: 'test-key' },",
  '  ],',
  '  stages: {',
  `    implement: { provider: 'anthropic', backend: 'cli'${stepVerification ? `, planStepVerification: ${JSON.stringify(stepVerification)}` : ''} },`,
  '  },',
  '};',
  '',
].join('\n');

const git = (cwd: string, args: string[]): void => {
  spawnSync('git', args, { cwd, stdio: 'pipe' });
};

const initRepo = (
  repoDir: string, plannedFiles: string[], extraFiles: Record<string, string> = {},
  stepVerification?: Record<string, unknown>,
): void => {
  git(repoDir, ['init']);
  git(repoDir, ['config', 'user.email', 'test@test.com']);
  git(repoDir, ['config', 'user.name', 'Test']);
  fs.writeFileSync(path.join(repoDir, 'wf.config.js'), buildWfConfig(stepVerification), 'utf-8');
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
  estimatedComplexity: overrides.estimatedComplexity ?? 'low',
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

const buildLayoutPaths = (tempRoot: string): Omit<ImplementHarness, 'planPath'> => ({
  tempRoot,
  repoDir: path.join(tempRoot, 'repo'),
  binDir: path.join(tempRoot, 'bin'),
  homeDir: path.join(tempRoot, 'home'),
  promptDir: path.join(tempRoot, 'prompts'),
  countFile: path.join(tempRoot, 'spawn-count.txt'),
  envReportFile: path.join(tempRoot, 'env-report.log'),
});

const createLayout = (tempRoot: string): Omit<ImplementHarness, 'planPath'> => {
  const layout = buildLayoutPaths(tempRoot);
  for (const dir of [layout.repoDir, layout.binDir, layout.promptDir, ...homeStateDirs(layout.homeDir)]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(layout.countFile, '');
  fs.writeFileSync(layout.envReportFile, '');
  return layout;
};

const installFakeClaude = (layout: Omit<ImplementHarness, 'planPath'>, mode: FakeClaudeMode): void => {
  const { binDir, countFile, promptDir, envReportFile } = layout;
  fs.writeFileSync(path.join(binDir, 'scenario.json'), JSON.stringify({ mode, countFile, promptDir, envReportFile }));
  fs.writeFileSync(path.join(binDir, 'claude'), fakeClaudeSource, { mode: 0o755 });
};

export const setupImplementHarness = (
  prefix: string, mode: FakeClaudeMode, plannedFiles: string[], overrides: PlanOverrides = {},
): ImplementHarness => {
  const layout = createLayout(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  installFakeClaude(layout, mode);
  initRepo(layout.repoDir, plannedFiles, overrides.extraFiles, overrides.stepVerification);
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

export const readEnvReport = (harness: ImplementHarness): EnvReportEntry[] =>
  fs.readFileSync(harness.envReportFile, 'utf-8').split('\n').filter(Boolean).map(line => JSON.parse(line));

export const cleanupHarness = (harness: ImplementHarness): void => {
  fs.rmSync(harness.tempRoot, { recursive: true, force: true });
};
