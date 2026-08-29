/**
 * Manual smoke test: Codex repair-pass failure degrades to a parse error, not a crash
 *
 * Run: nr test:manual -- test-issue-plan-codex-repair-pass-failure-live
 *
 * Scenario: If the in-session repair pass itself fails (e.g. `codex exec
 * resume` reports "thread not found" — a stale-resume-shaped error, not a
 * schema miss), `runCodexRetryPass`'s try/catch must degrade to pass 1's
 * invalid content, producing a clean `parse`-category error instead of an
 * uncaught crash or an unwanted whole-stage stale-resume restart.
 *
 * Config under test:
 *   ai: [
 *     { provider: 'openai', model: 'gpt-5.4', default: true }
 *   ]
 *   stages: {
 *     plan: { provider: 'openai', backend: 'cli' }
 *   }
 *
 * Verify:
 *   1. The command exits non-zero (not a hang, not a raw stack trace).
 *   2. The fake Codex binary is invoked exactly twice.
 *   3. The run does NOT restart the whole plan stage from scratch (no
 *      second `thread.started` message with a fresh thread id).
 *   4. No plan artifact is written.
 *
 * Wire up: fake `codex` script — first invocation emits `thread.started` +
 * phase-nested JSON; second invocation (the repair pass, detected via the
 * `resume` arg) exits non-zero with stderr `Codex CLI failed: thread not
 * found` and no NDJSON output at all. Config omits an API key so the
 * downstream fallback fails fast without a real network call.
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

type SpawnResult = {
  status: number | null;
  stdout: string;
  stderr: string;
};

const projectRoot = path.resolve(__dirname, '../..');
const distMainPath = path.join(projectRoot, 'dist', 'main.js');

let passed = 0;
let failed = 0;

const pass = (message: string): void => {
  console.log(chalk.green(`  ✓ ${message}`));
  passed += 1;
};

const fail = (message: string, detail?: string): void => {
  console.error(chalk.red(`  ✗ ${message}`));
  if (detail) console.error(chalk.gray(`    ${detail}`));
  failed += 1;
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

const incidentShapeJson = JSON.stringify({
  action: 'fix',
  summary: 'partial plan',
  phases: [{ name: 'Phase 1', steps: ['step 1'], verificationCheckpoint: 'verify' }],
});

const buildFakeCodexScript = (invocationLogPath: string): string => `#!/usr/bin/env node
const fs = require('fs');
const args = process.argv.slice(2);

if (args[0] === '--version') {
  console.log('codex-cli 0.142.5');
  process.exit(0);
}

fs.appendFileSync(${JSON.stringify(invocationLogPath)}, JSON.stringify(args) + '\\n');

const isResume = args.includes('resume');

let input = '';
process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('end', () => {
  if (isResume) {
    process.stderr.write('Codex CLI failed: thread not found\\n');
    process.exit(1);
  }
  console.log(JSON.stringify({ type: 'thread.started', thread_id: 'tid-3' }));
  console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: ${JSON.stringify(incidentShapeJson)} } }));
});
`;

async function main(): Promise<void> {
  if (!fs.existsSync(distMainPath)) {
    fail('dist/main.js must exist before running this smoke test', 'Run `yarn build` first.');
    process.exit(1);
  }

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-codex-repair-pass-failure-'));
  const homeDir = path.join(tempRoot, 'home');
  const repoDir = path.join(tempRoot, 'repo');
  const binDir = path.join(tempRoot, 'bin');
  const sourcePath = path.join(repoDir, 'source.md');
  const configPath = path.join(repoDir, 'wf.config.js');
  const codexScriptPath = path.join(binDir, 'codex');
  const codexAliasPath = path.join(binDir, 'Codex');
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
        "    { provider: 'openai', model: 'gpt-5.4', default: true },",
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
      ['# Smoke source', '', 'This file forces the real plan stage to invoke the CLI backend.', ''].join('\n'),
      'utf-8'
    );

    writeExecutable(codexAliasPath, ['#!/bin/sh', 'exit 0', ''].join('\n'));
    writeExecutable(codexScriptPath, buildFakeCodexScript(invocationLogPath));

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
    const threadStartedCount = (output.match(/thread\.started/g) ?? []).length;

    if (result.status !== 0) {
      pass('command exits non-zero');
    } else {
      fail('command should exit non-zero when the repair pass fails', output);
    }

    if (!output.includes('Codex CLI failed: thread not found') && !/at Object|at Module|node:internal/.test(output)) {
      pass('output is a clean diagnostic, not a raw stack trace');
    } else {
      fail('output should not surface a raw resume-failure stack trace', output);
    }

    if (invocations.length === 2) {
      pass('fake Codex binary was invoked exactly twice');
    } else {
      fail('expected exactly 2 Codex invocations', `got ${invocations.length}: ${JSON.stringify(invocations)}`);
    }

    if (threadStartedCount <= 1) {
      pass('the plan stage did not restart from scratch (no second fresh thread.started)');
    } else {
      fail('unexpected second thread.started — stale-resume full-stage restart was triggered', output);
    }

    if (!fs.existsSync(planPath)) {
      pass('no plan artifact was written');
    } else {
      fail('unexpected plan artifact exists after failure', planPath);
    }
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }

  console.log(chalk.bold(`\nSummary: ${passed} passed, ${failed} failed`));
  process.exit(failed > 0 ? 1 : 0);
}

void main();
