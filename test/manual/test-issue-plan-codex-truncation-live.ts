/**
 * Manual smoke test: issue:plan fails loudly when Codex truncates output
 *
 * Run: yarn test:manual test-issue-plan-codex-truncation-live
 *
 * Scenario: The user configures `stages.plan.backend: 'cli'` with the OpenAI
 * provider and the Codex CLI emits a partial plan plus `stop_reason:
 * 'max_tokens'`. The live CLI command must fail with truncation guidance and
 * must not write a plan artifact from the partial output.
 *
 * Config under test:
 *   ai: [
 *     { provider: 'openai', model: 'gpt-5.4', default: true, apiKey: 'k' }
 *   ]
 *   stages: {
 *     plan: { provider: 'openai', backend: 'cli' }
 *   }
 *
 * Verify:
 *   1. The command exits non-zero.
 *   2. The output includes truncation guidance for prompt/context reduction.
 *   3. The expected custom-plan artifact path does not exist after failure.
 *   4. The last Codex chunk is treated as a failure signal, not a success.
 *
 * Wire up: write a temporary `wf.config.js`, a `source.md` file, and temp
 * `Codex`/`codex` executables that emit NDJSON. Run the built CLI from
 * `dist/main.js` against the temp repo.
 * Teardown: remove the temp repo, fake executables, and isolated `HOME` tree.
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
} from '../../src/shared/utils/plan-artifact';

type SpawnResult = {
  status: number | null;
  stdout: string;
  stderr: string;
};

const projectRoot = path.resolve(__dirname, '../..');
const distMainPath = path.join(projectRoot, 'dist', 'main.js');

const pass = (message: string): void => console.log(chalk.green(`  ✓ ${message}`));
const fail = (message: string, detail?: string): void => {
  console.error(chalk.red(`  ✗ ${message}`));
  if (detail) console.error(chalk.gray(`    ${detail}`));
};

const writeExecutable = (filePath: string, content: string): void => {
  fs.writeFileSync(filePath, content, 'utf-8');
  fs.chmodSync(filePath, 0o755);
};

const runCommand = (cwd: string, sourcePath: string, env: NodeJS.ProcessEnv): SpawnResult => {
  const result = spawnSync(
    'node',
    [distMainPath, 'issue:plan', '--action', 'fix', '--custom-plan', sourcePath, '--silent'],
    { cwd, env, encoding: 'utf-8', maxBuffer: 1024 * 1024 * 10 }
  );

  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
};

async function main(): Promise<void> {
  if (!fs.existsSync(distMainPath)) {
    fail('dist/main.js must exist before running this smoke test', 'Run `yarn build` first.');
    process.exit(1);
  }

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-codex-truncation-'));
  const homeDir = path.join(tempRoot, 'home');
  const repoDir = path.join(tempRoot, 'repo');
  const binDir = path.join(tempRoot, 'bin');
  const sourcePath = path.join(repoDir, 'source.md');
  const configPath = path.join(repoDir, 'wf.config.js');
  const codexScriptPath = path.join(binDir, 'codex');
  const codexAliasPath = path.join(binDir, 'Codex');
  const repoName = path.basename(repoDir);
  const sourceStem = path.basename(sourcePath, '.md');
  const planFilename = buildPlanArtifactFilename({
    hash: hashPlanArtifactSources([sourceStem]),
    action: 'fix',
    format: 'json',
  });
  const artifactDir = path.join(homeDir, '.wf', repoName);
  const planPath = path.join(artifactDir, planFilename);
  const manifestPath = buildPlanArtifactManifestPath(planPath);
  let exitCode = 0;

  try {
    fs.mkdirSync(repoDir, { recursive: true });
    fs.mkdirSync(binDir, { recursive: true });
    fs.mkdirSync(homeDir, { recursive: true });
    fs.mkdirSync(path.join(homeDir, '.wf', 'logs'), { recursive: true });
    fs.mkdirSync(path.join(homeDir, '.wf', 'state'), { recursive: true });

    fs.writeFileSync(
      configPath,
      [
        'module.exports = {',
        '  ai: [',
        "    { provider: 'openai', model: 'gpt-5.4', default: true, apiKey: 'test-key' },",
        '  ],',
        '  stages: {',
        "    plan: { provider: 'openai', backend: 'cli', model: 'gpt-5.4' },",
        '  },',
        '};',
        '',
      ].join('\n'),
      'utf-8'
    );

    fs.writeFileSync(
      sourcePath,
      [
        '# Smoke source',
        '',
        'This file forces the real plan stage to invoke the CLI backend.',
        '',
      ].join('\n'),
      'utf-8'
    );

    writeExecutable(
      codexAliasPath,
      [
        '#!/bin/sh',
        'exit 0',
        '',
      ].join('\n')
    );

    writeExecutable(
      codexScriptPath,
      [
        '#!/bin/sh',
        'if [ "$1" = "--version" ]; then',
        '  echo "codex-cli 0.142.5"',
        '  exit 0',
        'fi',
        'cat <<\'EOF\'',
        '{"type":"thread.started","thread_id":"tid-123"}',
        '{"type":"item.completed","item":{"type":"agent_message","text":"{\\"action\\":\\"fix\\",\\"summary\\":\\"partial plan\\",\\"steps\\":[\\"step 1\\"],\\"estimatedComplexity\\":\\"low\\",\\"affectedFiles\\":[],\\"affectedRepositories\\":[\\"' + repoName + '\\"],\\"risks\\":[]}"}}',
        '{"type":"item.completed","stop_reason":"max_tokens","item":{"type":"agent_message","text":"{\\"action\\":\\"fix\\",\\"summary\\":\\"partial plan\\",\\"steps\\":[\\"step 1\\"],\\"estimatedComplexity\\":\\"low\\",\\"affectedFiles\\":[],\\"affectedRepositories\\":[\\"' + repoName + '\\"],\\"risks\\":[]}"}}',
        'EOF',
        '',
      ].join('\n')
    );

    const env = {
      ...process.env,
      HOME: homeDir,
      PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ''}`,
      WF_SKIP_CLI_VERSION_CHECK: '1',
    };

    const result = runCommand(repoDir, sourcePath, env);
    const output = `${result.stdout}\n${result.stderr}`;

    if (result.status === 0) {
      fail('issue:plan should fail when Codex reports max_tokens', `output:\n${output}`);
      exitCode = 1;
    }

    const truncationMessage = output.includes('Reduce prompt/context size or switch to provider-backed OpenAI');
    const artifactMissing = !fs.existsSync(planPath) && !fs.existsSync(manifestPath);
    if (truncationMessage) {
      pass('CLI output includes truncation guidance');
    } else {
      fail('CLI output should include truncation guidance', output);
    }

    if (artifactMissing) {
      pass('No custom plan artifact was written from the partial Codex output');
    } else {
      fail('Unexpected plan artifact or manifest exists after failure', `planPath: ${planPath}\nmanifestPath: ${manifestPath}`);
    }

    if (!truncationMessage || !artifactMissing) {
      exitCode = 1;
    }
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }

  process.exit(exitCode);
}

void main();
