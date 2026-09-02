/**
 * Manual smoke test: Markdown-fenced valid plan JSON is accepted without a spurious retry
 *
 * Run: nr test:manual -- test-issue-plan-claude-fenced-json-live
 *
 * Scenario: `resolveStageResponseIssues`/`resolveStageZodIssues` were fixed
 * to use the fence-aware `parseJsonResponse` instead of raw `JSON.parse`. A
 * schema-valid plan wrapped in a ```json code fence must be accepted on
 * pass 1 — it must NOT trigger an unnecessary in-session repair pass.
 *
 * Config under test:
 *   ai: [
 *     { provider: 'anthropic', model: 'claude-sonnet-4-6', default: true }
 *   ]
 *   stages: {
 *     plan: { provider: 'anthropic', backend: 'cli' }
 *   }
 *
 * Verify:
 *   1. The command exits 0 and writes a valid plan artifact.
 *   2. The fake `claude` binary is invoked exactly ONCE (no retry pass fired).
 *   3. The plan artifact's `summary` matches the fenced payload's content.
 *
 * Wire up: fake `claude` script emits a single stream-json result line whose
 * `result` field is the valid plan JSON wrapped in a ```json code fence.
 * Teardown: remove the temp repo, fake executable, and isolated `HOME` tree.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import chalk from 'chalk';
import {
  buildPlanArtifactFilename,
  hashPlanArtifactSources,
} from '../../src/shared/utils/plan-artifact';
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

const validPlanJson = JSON.stringify({
  action: 'fix',
  summary: 'Fenced plan accepted',
  steps: ['Step 1'],
  estimatedComplexity: 'low',
  affectedRepositories: ['repo'],
});

const fencedResult = ['```json', validPlanJson, '```'].join('\n');

const buildFakeClaudeScript = (invocationLogPath: string): string => `#!/usr/bin/env node
const fs = require('fs');
const args = process.argv.slice(2);

fs.appendFileSync(${JSON.stringify(invocationLogPath)}, JSON.stringify(args) + '\\n');

let input = '';
process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('end', () => {
  console.log(JSON.stringify({ type: 'result', subtype: 'success', result: ${JSON.stringify(fencedResult)}, session_id: 'sess-8' }));
});
`;

async function main(): Promise<void> {
  if (!fs.existsSync(distMainPath)) {
    fail('dist/main.js must exist before running this smoke test', 'Run `yarn build` first.');
    process.exit(1);
  }

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-claude-fenced-json-'));
  const homeDir = path.join(tempRoot, 'home');
  const repoDir = path.join(tempRoot, 'repo');
  const binDir = path.join(tempRoot, 'bin');
  const sourcePath = path.join(repoDir, 'source.md');
  const configPath = path.join(repoDir, 'wf.config.js');
  const claudeScriptPath = path.join(binDir, 'claude');
  const invocationLogPath = path.join(tempRoot, 'invocations.log');
  const repoName = path.basename(repoDir);
  const sourceStem = path.basename(sourcePath, '.md');
  const planFilename = buildPlanArtifactFilename({
    hash: hashPlanArtifactSources([sourceStem]),
    action: 'fix',
    format: 'json',
  });
  const artifactDir = path.join(homeDir, '.wf', repoName);
  const planPath = path.join(artifactDir, planFilename);

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
        "    { provider: 'anthropic', model: 'claude-sonnet-4-6', default: true, apiKey: 'test-key' },",
        '  ],',
        '  stages: {',
        "    plan: { provider: 'anthropic', backend: 'cli', model: 'claude-sonnet-4-6' },",
        '  },',
        '};',
        '',
      ].join('\n'),
      'utf-8'
    );

    fs.writeFileSync(
      sourcePath,
      ['# Smoke source', '', 'This file forces the real plan stage to invoke the CLI backend.', ''].join('\n'),
      'utf-8'
    );

    writeExecutable(claudeScriptPath, buildFakeClaudeScript(invocationLogPath));

    const env = {
      ...process.env,
      HOME: homeDir,
      PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ''}`,
      WF_SKIP_CLI_VERSION_CHECK: '1',
    };

    const result = runCommand(repoDir, sourcePath, env);
    const output = `${result.stdout}\n${result.stderr}`;
    const invocations = fs.existsSync(invocationLogPath)
      ? fs.readFileSync(invocationLogPath, 'utf-8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
      : [];

    if (result.status === 0) {
      pass('command exits 0');
    } else {
      fail('command should exit 0', output);
    }

    if (fs.existsSync(planPath)) {
      pass('a plan artifact was written');
    } else {
      fail('expected a plan artifact to be written', `planPath: ${planPath}\noutput:\n${output}`);
    }

    if (invocations.length === 1) {
      pass('fake claude binary was invoked exactly once (no spurious retry)');
    } else {
      fail('expected exactly 1 claude invocation', `got ${invocations.length}: ${JSON.stringify(invocations)}`);
    }

    if (fs.existsSync(planPath)) {
      const artifact = JSON.parse(fs.readFileSync(planPath, 'utf-8'));
      if (artifact.summary === 'Fenced plan accepted') {
        pass('plan artifact reflects the fenced payload content');
      } else {
        fail('plan artifact should reflect the fenced payload', JSON.stringify(artifact.summary));
      }
    }
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }

  console.log(chalk.bold(`\nSummary: ${counts.passed} passed, ${counts.failed} failed`));
  process.exit(counts.failed > 0 ? 1 : 0);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
