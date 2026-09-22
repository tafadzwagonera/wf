/**
 * Manual smoke test: Codex CLI version-aware auto-approval flag selection
 *
 * Run: nr test:manual codex-cli-version-flag-live.smoke.ts
 *
 * Scenario: The implement stage spawns the Codex CLI as a subprocess. From
 * v0.147 onward `--full-auto` was removed and replaced by
 * `--sandbox workspace-write`. This test verifies that the live CLI pipeline
 * threads the detected version through to the subprocess args correctly.
 *
 * Verify:
 *   1. Fake codex reporting 0.147.0 → args contain --sandbox workspace-write,
 *      NOT --full-auto.
 *   2. Fake codex reporting 0.146.1 → args contain --full-auto, NOT --sandbox.
 *   3. WF_SKIP_CLI_VERSION_CHECK=1 with no --version handler → args contain
 *      --full-auto (safe fallback for unknown version).
 *
 * Wire up: write a fake codex binary that logs its args to a file and emits
 * minimal NDJSON on stdout, then run `node dist/main.js issue:implement` with
 * a pre-built plan artifact.
 * Teardown: remove the temp repo, fake binaries, and isolated HOME tree.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import chalk from 'chalk';
import {
  buildPlanArtifactFilename,
  buildPlanArtifactManifestPath,
  hashPlanArtifactSources,
  writePlanArtifactManifest,
} from '../../src/shared/utils/plan-artifact';
import { createReporter } from './support/reporter';

const projectRoot = path.resolve(__dirname, '../..');
const distMainPath = path.join(projectRoot, 'dist', 'main.js');

const { counts, pass, fail } = createReporter();

const writeExecutable = (filePath: string, content: string): void => {
  fs.writeFileSync(filePath, content, 'utf-8');
  fs.chmodSync(filePath, 0o755);
};

type ScenarioResult = { args: string; exitCode: number | null; output: string };

type TempRepo = {
  tempRoot: string;
  repoDir: string;
  binDir: string;
  homeDir: string;
  argsLogPath: string;
  planPath: string;
};

interface ScenarioOpts {
  argsLogPath: string;
  binDir: string;
  repoDir: string;
  homeDir: string;
  planPath: string;
  extraEnv?: Record<string, string>;
}

const buildPlanJson = (repoName: string): string => JSON.stringify({
  action: 'fix',
  summary: 'smoke test plan',
  steps: ['step 1'],
  estimatedComplexity: 'low',
  affectedFiles: [],
  affectedRepositories: [repoName],
  risks: [],
});

const buildWfConfig = (): string => [
  'module.exports = {',
  '  ai: [',
  "    { provider: 'openai', model: 'gpt-5.4', default: true, apiKey: 'test-key' },",
  '  ],',
  '  stages: {',
  "    implement: { provider: 'openai', backend: 'cli' },",
  '  },',
  '};',
  '',
].join('\n');

const buildFakeCodexScript = (version: string, argsLogPath: string): string => [
  '#!/bin/sh',
  'if [ "$1" = "--version" ]; then',
  `  echo "codex-cli ${version}"`,
  '  exit 0',
  'fi',
  `echo "$@" >> "${argsLogPath}"`,
  'cat <<\'NDJSON\'',
  '{"type":"thread.started","thread_id":"tid-smoke"}',
  '{"type":"item.completed","item":{"type":"agent_message","text":"Implementation complete."}}',
  'NDJSON',
  '',
].join('\n');

const buildFakeCodexBypassScript = (argsLogPath: string): string => [
  '#!/bin/sh',
  'if [ "$1" = "--version" ]; then',
  '  echo "codex-cli 0.0.0"',
  '  exit 0',
  'fi',
  `echo "$@" >> "${argsLogPath}"`,
  'cat <<\'NDJSON\'',
  '{"type":"thread.started","thread_id":"tid-smoke"}',
  '{"type":"item.completed","item":{"type":"agent_message","text":"Implementation complete."}}',
  'NDJSON',
  '',
].join('\n');

const createTempDirectories = (homeDir: string, repoDir: string, binDir: string): void => {
  fs.mkdirSync(repoDir, { recursive: true });
  fs.mkdirSync(binDir, { recursive: true });
  fs.mkdirSync(homeDir, { recursive: true });
  fs.mkdirSync(path.join(homeDir, '.wf', 'logs'), { recursive: true });
  fs.mkdirSync(path.join(homeDir, '.wf', 'state'), { recursive: true });
};

const initGitRepo = (repoDir: string): void => {
  // Initialize a bare git repo so the command doesn't fail on git operations
  spawnSync('git', ['init'], { cwd: repoDir, stdio: 'pipe' });
  spawnSync('git', ['config', 'user.email', 'test@test.com'], { cwd: repoDir, stdio: 'pipe' });
  spawnSync('git', ['config', 'user.name', 'Test'], { cwd: repoDir, stdio: 'pipe' });
  fs.writeFileSync(path.join(repoDir, 'wf.config.js'), buildWfConfig(), 'utf-8');
  fs.writeFileSync(path.join(repoDir, 'README.md'), '# Smoke\n', 'utf-8');
  spawnSync('git', ['add', '.'], { cwd: repoDir, stdio: 'pipe' });
  spawnSync('git', ['commit', '-m', 'init'], { cwd: repoDir, stdio: 'pipe' });
};

const writePlanManifest = (planPath: string, hash: string, sourceStem: string): void => {
  writePlanArtifactManifest({
    artifactPath: planPath,
    action: 'fix',
    createdAt: new Date().toISOString(),
    hash,
    format: 'json',
    sourceKind: 'custom',
    sourceName: sourceStem,
  });
};

const writePlanArtifact = (homeDir: string, repoName: string): string => {
  const sourceStem = 'source';
  const hash = hashPlanArtifactSources([sourceStem]);
  const planFilename = buildPlanArtifactFilename({ hash, action: 'fix', format: 'json' });
  const artifactDir = path.join(homeDir, '.wf', repoName);
  fs.mkdirSync(artifactDir, { recursive: true });
  const planPath = path.join(artifactDir, planFilename);
  fs.writeFileSync(planPath, buildPlanJson(repoName), 'utf-8');
  writePlanManifest(planPath, hash, sourceStem);
  return planPath;
};

const setupTempRepo = (): TempRepo => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-codex-flag-'));
  const homeDir = path.join(tempRoot, 'home');
  const repoDir = path.join(tempRoot, 'repo');
  const binDir = path.join(tempRoot, 'bin');
  const argsLogPath = path.join(tempRoot, 'codex-args.log');
  const repoName = path.basename(repoDir);
  createTempDirectories(homeDir, repoDir, binDir);
  initGitRepo(repoDir);
  const planPath = writePlanArtifact(homeDir, repoName);
  // Write the fake Codex alias (satisfies `command -v Codex`)
  writeExecutable(path.join(binDir, 'Codex'), '#!/bin/sh\nexit 0\n');
  return { tempRoot, repoDir, binDir, homeDir, argsLogPath, planPath };
};

const buildProcessEnv = (
  binDir: string, homeDir: string, extraEnv?: Record<string, string>,
): NodeJS.ProcessEnv => ({
  ...process.env,
  HOME: homeDir,
  PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ''}`,
  ...extraEnv,
});

const runImplement = (
  repoDir: string, binDir: string, homeDir: string, planPath: string,
  extraEnv?: Record<string, string>,
): ScenarioResult => {
  const env = buildProcessEnv(binDir, homeDir, extraEnv);
  const result = spawnSync(
    'node',
    [distMainPath, 'issue:implement', planPath, '--silent', '--no-branch'],
    { cwd: repoDir, env, encoding: 'utf-8', maxBuffer: 1024 * 1024 * 10, timeout: 30_000 },
  );
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  return { args: '', exitCode: result.status, output };
};

const resolveCodexScript = (
  version: string, argsLogPath: string, extraEnv?: Record<string, string>,
): string =>
  extraEnv?.['WF_SKIP_CLI_VERSION_CHECK'] === '1'
    ? buildFakeCodexBypassScript(argsLogPath)
    : buildFakeCodexScript(version, argsLogPath);

const runScenario = (
  label: string, version: string, opts: ScenarioOpts,
): ScenarioResult => {
  console.log(chalk.bold(`\n${label}`));
  if (fs.existsSync(opts.argsLogPath)) fs.unlinkSync(opts.argsLogPath);
  const codexPath = path.join(opts.binDir, 'codex');
  const script = resolveCodexScript(version, opts.argsLogPath, opts.extraEnv);
  writeExecutable(codexPath, script);
  const result = runImplement(opts.repoDir, opts.binDir, opts.homeDir, opts.planPath, opts.extraEnv);
  const args = fs.existsSync(opts.argsLogPath)
    ? fs.readFileSync(opts.argsLogPath, 'utf-8').trim()
    : '';
  return { ...result, args };
};

const checkArg = (ok: boolean, passMsg: string, failMsg: string, detail: string): 0 | 1 => {
  if (ok) {
    pass(passMsg);
    return 0;
  }
  fail(failMsg, detail);
  return 1;
};

const assertSandboxArgs = (result: ScenarioResult): number => {
  const c1 = checkArg(
    result.args.includes('--sandbox') && result.args.includes('workspace-write'),
    'args contain --sandbox workspace-write',
    'expected --sandbox workspace-write in args',
    `args: ${result.args}`,
  );
  const c2 = checkArg(
    !result.args.includes('--full-auto'),
    'args do NOT contain --full-auto',
    '--full-auto should not appear for v0.147',
    `args: ${result.args}`,
  );
  return c1 | c2;
};

const assertFullAutoArgs = (result: ScenarioResult): number => {
  const c1 = checkArg(
    result.args.includes('--full-auto'),
    'args contain --full-auto',
    'expected --full-auto in args',
    `args: ${result.args}`,
  );
  const c2 = checkArg(
    !result.args.includes('--sandbox'),
    'args do NOT contain --sandbox',
    '--sandbox should not appear for v0.146',
    `args: ${result.args}`,
  );
  return c1 | c2;
};

const assertFallbackArgs = (result: ScenarioResult): number => {
  const c1 = checkArg(
    result.args.includes('--full-auto'),
    'args contain --full-auto (fallback)',
    'expected --full-auto as fallback when version check is skipped',
    `args: ${result.args}`,
  );
  const c2 = checkArg(
    !result.args.includes('--sandbox'),
    'args do NOT contain --sandbox',
    '--sandbox should not appear when version is unknown',
    `args: ${result.args}`,
  );
  return c1 | c2;
};

const runScenario1 = (opts: ScenarioOpts): number => {
  const s = runScenario(
    'Scenario 1: Codex v0.147.0 uses --sandbox workspace-write',
    '0.147.0',
    opts,
  );
  return assertSandboxArgs(s);
};

const runScenario2 = (opts: ScenarioOpts): number => {
  const s = runScenario(
    'Scenario 2: Codex v0.146.1 uses --full-auto',
    '0.146.1',
    opts,
  );
  return assertFullAutoArgs(s);
};

const runScenario3 = (opts: ScenarioOpts): number => {
  const s = runScenario(
    'Scenario 3: WF_SKIP_CLI_VERSION_CHECK=1 defaults to --full-auto',
    '0.0.0',
    { ...opts, extraEnv: { WF_SKIP_CLI_VERSION_CHECK: '1' } },
  );
  return assertFallbackArgs(s);
};

const verifyDistMain = (): void => {
  if (fs.existsSync(distMainPath)) {
    pass('dist/main.js exists');
  } else {
    fail('dist/main.js must exist', 'Run `yarn build` first.');
    process.exit(1);
  }
};

const printSummary = (exitCode: number): void => {
  console.log(chalk.bold('\nSummary'));
  console.log(`  Passed: ${counts.passed}`);
  console.log(`  Failed: ${counts.failed}`);
  process.exit(exitCode || (counts.failed > 0 ? 1 : 0));
};

async function main(): Promise<void> {
  console.log(chalk.bold.cyan('\n  Codex CLI version-aware flag selection — live smoke test\n'));
  verifyDistMain();
  const { tempRoot, ...scenarioOpts } = setupTempRepo();
  let exitCode = 0;
  try {
    exitCode |= runScenario1(scenarioOpts);
    exitCode |= runScenario2(scenarioOpts);
    exitCode |= runScenario3(scenarioOpts);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
  printSummary(exitCode);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
