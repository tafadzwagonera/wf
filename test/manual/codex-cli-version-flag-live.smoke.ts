/**
 * Manual smoke test: Codex CLI version-aware auto-approval flag selection
 *
 * Run: nr test:manual -- test-codex-cli-version-flag-live
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

const setupTempRepo = (): {
  tempRoot: string; repoDir: string; binDir: string; homeDir: string;
  argsLogPath: string; planPath: string;
} => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-codex-flag-'));
  const homeDir = path.join(tempRoot, 'home');
  const repoDir = path.join(tempRoot, 'repo');
  const binDir = path.join(tempRoot, 'bin');
  const argsLogPath = path.join(tempRoot, 'codex-args.log');
  const repoName = path.basename(repoDir);

  fs.mkdirSync(repoDir, { recursive: true });
  fs.mkdirSync(binDir, { recursive: true });
  fs.mkdirSync(homeDir, { recursive: true });
  fs.mkdirSync(path.join(homeDir, '.wf', 'logs'), { recursive: true });
  fs.mkdirSync(path.join(homeDir, '.wf', 'state'), { recursive: true });

  // Initialize a bare git repo so the command doesn't fail on git operations
  spawnSync('git', ['init'], { cwd: repoDir, stdio: 'pipe' });
  spawnSync('git', ['config', 'user.email', 'test@test.com'], { cwd: repoDir, stdio: 'pipe' });
  spawnSync('git', ['config', 'user.name', 'Test'], { cwd: repoDir, stdio: 'pipe' });

  // Write config
  fs.writeFileSync(path.join(repoDir, 'wf.config.js'), buildWfConfig(), 'utf-8');

  // Write a dummy file and commit so the repo is not empty
  fs.writeFileSync(path.join(repoDir, 'README.md'), '# Smoke\n', 'utf-8');
  spawnSync('git', ['add', '.'], { cwd: repoDir, stdio: 'pipe' });
  spawnSync('git', ['commit', '-m', 'init'], { cwd: repoDir, stdio: 'pipe' });

  // Write plan artifact
  const sourceStem = 'source';
  const hash = hashPlanArtifactSources([sourceStem]);
  const planFilename = buildPlanArtifactFilename({ hash, action: 'fix', format: 'json' });
  const artifactDir = path.join(homeDir, '.wf', repoName);
  fs.mkdirSync(artifactDir, { recursive: true });
  const planPath = path.join(artifactDir, planFilename);
  fs.writeFileSync(planPath, buildPlanJson(repoName), 'utf-8');

  // Write manifest
  writePlanArtifactManifest({
    artifactPath: planPath,
    action: 'fix',
    createdAt: new Date().toISOString(),
    hash,
    format: 'json',
    sourceKind: 'custom',
    sourceName: sourceStem,
  });

  // Write the fake Codex alias (satisfies `command -v Codex`)
  writeExecutable(path.join(binDir, 'Codex'), '#!/bin/sh\nexit 0\n');

  return { tempRoot, repoDir, binDir, homeDir, argsLogPath, planPath };
};

const runImplement = (
  repoDir: string, binDir: string, homeDir: string, planPath: string,
  extraEnv?: Record<string, string>,
): ScenarioResult => {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: homeDir,
    PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ''}`,
    ...extraEnv,
  };

  const result = spawnSync(
    'node',
    [distMainPath, 'issue:implement', planPath, '--silent', '--no-branch'],
    { cwd: repoDir, env, encoding: 'utf-8', maxBuffer: 1024 * 1024 * 10, timeout: 30_000 },
  );

  return {
    args: '', // filled after reading the log
    exitCode: result.status,
    output: `${result.stdout ?? ''}\n${result.stderr ?? ''}`,
  };
};

const runScenario = (
  label: string, version: string, argsLogPath: string, binDir: string,
  repoDir: string, homeDir: string, planPath: string,
  extraEnv?: Record<string, string>,
): ScenarioResult => {
  console.log(chalk.bold(`\n${label}`));

  // Clean arg log from previous scenario
  if (fs.existsSync(argsLogPath)) fs.unlinkSync(argsLogPath);

  // Write fake codex script for this scenario
  const codexPath = path.join(binDir, 'codex');
  const script = extraEnv?.['WF_SKIP_CLI_VERSION_CHECK'] === '1'
    ? buildFakeCodexBypassScript(argsLogPath)
    : buildFakeCodexScript(version, argsLogPath);
  writeExecutable(codexPath, script);

  const result = runImplement(repoDir, binDir, homeDir, planPath, extraEnv);

  const args = fs.existsSync(argsLogPath) ? fs.readFileSync(argsLogPath, 'utf-8').trim() : '';
  return { ...result, args };
};

async function main(): Promise<void> {
  console.log(chalk.bold.cyan('\n  Codex CLI version-aware flag selection — live smoke test\n'));

  if (!fs.existsSync(distMainPath)) {
    fail('dist/main.js must exist', 'Run `yarn build` first.');
    process.exit(1);
  }

  const { tempRoot, repoDir, binDir, homeDir, argsLogPath, planPath } = setupTempRepo();
  let exitCode = 0;

  try {
    // Scenario 1: v0.147.0 → --sandbox workspace-write
    const s1 = runScenario(
      'Scenario 1: Codex v0.147.0 uses --sandbox workspace-write',
      '0.147.0', argsLogPath, binDir, repoDir, homeDir, planPath,
    );
    if (s1.args.includes('--sandbox') && s1.args.includes('workspace-write')) {
      pass('args contain --sandbox workspace-write');
    } else {
      fail('expected --sandbox workspace-write in args', `args: ${s1.args}`);
      exitCode = 1;
    }
    if (s1.args.includes('--full-auto')) {
      fail('--full-auto should not appear for v0.147', `args: ${s1.args}`);
      exitCode = 1;
    } else {
      pass('args do NOT contain --full-auto');
    }

    // Scenario 2: v0.146.1 → --full-auto
    const s2 = runScenario(
      'Scenario 2: Codex v0.146.1 uses --full-auto',
      '0.146.1', argsLogPath, binDir, repoDir, homeDir, planPath,
    );
    if (s2.args.includes('--full-auto')) {
      pass('args contain --full-auto');
    } else {
      fail('expected --full-auto in args', `args: ${s2.args}`);
      exitCode = 1;
    }
    if (s2.args.includes('--sandbox')) {
      fail('--sandbox should not appear for v0.146', `args: ${s2.args}`);
      exitCode = 1;
    } else {
      pass('args do NOT contain --sandbox');
    }

    // Scenario 3: version check bypassed → --full-auto fallback
    const s3 = runScenario(
      'Scenario 3: WF_SKIP_CLI_VERSION_CHECK=1 defaults to --full-auto',
      '0.0.0', argsLogPath, binDir, repoDir, homeDir, planPath,
      { WF_SKIP_CLI_VERSION_CHECK: '1' },
    );
    if (s3.args.includes('--full-auto')) {
      pass('args contain --full-auto (fallback)');
    } else {
      fail('expected --full-auto as fallback when version check is skipped', `args: ${s3.args}`);
      exitCode = 1;
    }
    if (s3.args.includes('--sandbox')) {
      fail('--sandbox should not appear when version is unknown', `args: ${s3.args}`);
      exitCode = 1;
    } else {
      pass('args do NOT contain --sandbox');
    }
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }

  console.log(chalk.bold('\nSummary'));
  console.log(`  Passed: ${counts.passed}`);
  console.log(`  Failed: ${counts.failed}`);
  process.exit(exitCode || (counts.failed > 0 ? 1 : 0));
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
