import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  buildPlanArtifactFilename,
  hashPlanArtifactSources,
  writePlanArtifactManifest,
} from '../../../src/common/utils/plan-artifact';
import { distMainPath } from './implement-cli-harness';
import type { RunResult } from './implement-cli-harness';

export type CodexEnvReportEntry = { hasOpenaiApiKey: boolean; hasPath: boolean };

export type CodexImplementHarness = {
  tempRoot: string;
  repoDir: string;
  binDir: string;
  homeDir: string;
  planPath: string;
  envReportFile: string;
};

const fakeCodexSource = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const here = __dirname;
if (process.argv[2] === '--version') {
  console.log('codex-cli 0.150.0');
  process.exit(0);
}
const { envReportFile } = JSON.parse(fs.readFileSync(path.join(here, 'scenario.json'), 'utf8'));
fs.appendFileSync(envReportFile, JSON.stringify({
  hasOpenaiApiKey: Boolean(process.env.OPENAI_API_KEY), hasPath: Boolean(process.env.PATH),
}) + '\\n');
fs.readFileSync(0, 'utf8');
console.log(JSON.stringify({ type: 'thread.started', thread_id: 'tid-1' }));
console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'done' } }));
console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } }));
`;

const buildWfConfig = (): string => [
  'module.exports = {',
  '  ai: [',
  "    { provider: 'openai', model: 'gpt-5.1-codex', default: true, apiKey: 'test-key' },",
  '  ],',
  '  stages: {',
  "    implement: { provider: 'openai', backend: 'cli' },",
  '  },',
  '};',
  '',
].join('\n');

const git = (cwd: string, args: string[]): void => {
  spawnSync('git', args, { cwd, stdio: 'pipe' });
};

const initRepo = (repoDir: string, plannedFiles: string[]): void => {
  git(repoDir, ['init']);
  git(repoDir, ['config', 'user.email', 'test@test.com']);
  git(repoDir, ['config', 'user.name', 'Test']);
  fs.writeFileSync(path.join(repoDir, 'wf.config.js'), buildWfConfig(), 'utf-8');
  fs.writeFileSync(path.join(repoDir, 'README.md'), '# Smoke\n', 'utf-8');
  fs.mkdirSync(path.join(repoDir, 'src'), { recursive: true });
  for (const file of plannedFiles) fs.writeFileSync(path.join(repoDir, file), 'export {};\n', 'utf-8');
  git(repoDir, ['add', '.']);
  git(repoDir, ['commit', '-m', 'init']);
};

const buildPlanJson = (repoName: string, plannedFiles: string[]): string => JSON.stringify({
  action: 'fix',
  summary: 'smoke test plan',
  steps: ['step 1'],
  estimatedComplexity: 'low',
  affectedFiles: plannedFiles.map(file => `${repoName}/${file}`),
  affectedRepositories: [repoName],
  risks: [],
});

const writePlanArtifact = (homeDir: string, repoName: string, plannedFiles: string[]): string => {
  const sourceStem = 'source';
  const hash = hashPlanArtifactSources([sourceStem]);
  const planPath = path.join(homeDir, '.wf', repoName, buildPlanArtifactFilename({ hash, action: 'fix', format: 'json' }));
  fs.mkdirSync(path.dirname(planPath), { recursive: true });
  fs.writeFileSync(planPath, buildPlanJson(repoName, plannedFiles), 'utf-8');
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

const buildLayoutPaths = (tempRoot: string): Omit<CodexImplementHarness, 'planPath'> => ({
  tempRoot,
  repoDir: path.join(tempRoot, 'repo'),
  binDir: path.join(tempRoot, 'bin'),
  homeDir: path.join(tempRoot, 'home'),
  envReportFile: path.join(tempRoot, 'env-report.log'),
});

const installFakeCodex = (layout: Omit<CodexImplementHarness, 'planPath'>): void => {
  fs.writeFileSync(layout.envReportFile, '');
  fs.writeFileSync(path.join(layout.binDir, 'scenario.json'), JSON.stringify({ envReportFile: layout.envReportFile }));
  fs.writeFileSync(path.join(layout.binDir, 'codex'), fakeCodexSource, { mode: 0o755 });
};

export const setupCodexImplementHarness = (prefix: string, plannedFiles: string[]): CodexImplementHarness => {
  const layout = buildLayoutPaths(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  for (const dir of [layout.repoDir, layout.binDir, ...homeStateDirs(layout.homeDir)]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  installFakeCodex(layout);
  initRepo(layout.repoDir, plannedFiles);
  const planPath = writePlanArtifact(layout.homeDir, path.basename(layout.repoDir), plannedFiles);
  return { ...layout, planPath };
};

export const runCodexImplement = (harness: CodexImplementHarness, timeoutMs = 60_000): RunResult => {
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

export const readCodexEnvReport = (harness: CodexImplementHarness): CodexEnvReportEntry[] =>
  fs.readFileSync(harness.envReportFile, 'utf-8').split('\n').filter(Boolean).map(line => JSON.parse(line));

export const cleanupCodexHarness = (harness: CodexImplementHarness): void => {
  fs.rmSync(harness.tempRoot, { recursive: true, force: true });
};
