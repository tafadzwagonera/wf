/**
 * Manual smoke test: Codex plan schema-retry exhaustion gives Codex its full
 * repair opportunity before any downstream fallback, and fails cleanly
 *
 * Run: nr test:manual -- test-issue-plan-codex-schema-exhaustion-live
 *
 * Scenario: When BOTH Codex passes emit schema-invalid JSON, the schema-defense
 * loop must give Codex its full 2-pass repair opportunity — carrying the
 * injected JSON Schema on pass 1 and the corrective Zod diagnostic on pass 2 —
 * before anything falls through to the last-resort completions repair. (That
 * repair path itself is untouched, backend-blind, platform-routed behavior —
 * out of scope for this fix — so the config here omits an API key to keep the
 * fallback's own failure fast and network-free rather than asserting on
 * whichever provider/network error it happens to surface.)
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
 *   1. The command exits non-zero.
 *   2. The fake Codex binary is invoked exactly twice.
 *   3. The first invocation's prompt carries the injected JSON Schema.
 *   4. The second invocation resumes the pass-1 thread id and carries the
 *      `Field: 'steps'` corrective diagnostic — proving the retry loop, not
 *      an immediate bail-out, ran before any fallback.
 *   5. No plan artifact is written.
 *   6. The final output is a clean, categorized configuration/provider error
 *      (not a raw stack trace, not a stall/"workload not decreasing" message,
 *      not a 429).
 *
 * Wire up: same temp-repo/fake-binary harness as the schema-repair-live
 * test, but the fake `codex` script always emits the phase-nested
 * (schema-invalid) payload regardless of invocation count, and the config
 * has no `apiKey` so the downstream repair fails fast on a configuration
 * error instead of making a real network call.
 * Teardown: remove the temp repo, fake executables, and isolated `HOME` tree.
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

let input = '';
process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('end', () => {
  fs.appendFileSync(${JSON.stringify(invocationLogPath)}.replace(/\\.log$/, '.prompts.log'), input + '\\n---\\n');

  const isResume = args.includes('resume');
  if (!isResume) {
    console.log(JSON.stringify({ type: 'thread.started', thread_id: 'tid-2' }));
  }
  console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: ${JSON.stringify(incidentShapeJson)} } }));
});
`;

async function main(): Promise<void> {
  if (!fs.existsSync(distMainPath)) {
    fail('dist/main.js must exist before running this smoke test', 'Run `yarn build` first.');
    process.exit(1);
  }

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-codex-schema-exhaustion-'));
  const homeDir = path.join(tempRoot, 'home');
  const repoDir = path.join(tempRoot, 'repo');
  const binDir = path.join(tempRoot, 'bin');
  const sourcePath = path.join(repoDir, 'source.md');
  const configPath = path.join(repoDir, 'wf.config.js');
  const codexScriptPath = path.join(binDir, 'codex');
  const codexAliasPath = path.join(binDir, 'Codex');
  const invocationLogPath = path.join(tempRoot, 'invocations.log');
  const promptsLogPath = path.join(tempRoot, 'invocations.prompts.log');
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
    const prompts = fs.existsSync(promptsLogPath)
      ? fs.readFileSync(promptsLogPath, 'utf-8').split('\n---\n').filter(Boolean)
      : [];

    if (result.status !== 0) {
      pass('command exits non-zero');
    } else {
      fail('command should exit non-zero when both passes are schema-invalid', output);
    }

    if (invocations.length === 2) {
      pass('fake Codex binary was invoked exactly twice');
    } else {
      fail('expected exactly 2 Codex invocations', `got ${invocations.length}: ${JSON.stringify(invocations)}`);
    }

    const firstPrompt = prompts[0] ?? '';
    if (firstPrompt.includes('Output contract') && firstPrompt.includes('"stepIndices"')) {
      pass('first invocation prompt carries the injected JSON Schema');
    } else {
      fail('first invocation prompt should contain the JSON Schema', firstPrompt.slice(0, 500));
    }

    const secondPrompt = prompts[1] ?? '';
    const secondArgs = invocations[1] ?? [];
    if (secondArgs.includes('resume') && secondArgs.includes('tid-2') && secondPrompt.includes("Field: 'steps'")) {
      pass('second invocation resumed pass 1 and carried the corrective Zod diagnostic');
    } else {
      fail(
        'second invocation should resume tid-2 with the corrective diagnostic',
        `args: ${JSON.stringify(secondArgs)}\nprompt: ${secondPrompt.slice(0, 500)}`
      );
    }

    if (fs.existsSync(planPath)) {
      fail('unexpected plan artifact exists after failure', planPath);
    } else {
      pass('no plan artifact was written');
    }

    if (/\b429\b/.test(output) || output.includes('workload not decreasing')) {
      fail('final output unexpectedly looks like a 429 or stall failure', output);
    } else {
      pass('final output is not a 429 or a stall/"workload not decreasing" message');
    }

    if (output.includes('ConfigurationError') || output.includes('not initialized')) {
      pass('the last-resort fallback fails with a clean, categorized configuration error, not a crash');
    } else {
      fail('expected a clean configuration-error message from the untouched fallback path', output);
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
