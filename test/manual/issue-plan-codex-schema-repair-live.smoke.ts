/**
 * Manual smoke test: Codex plan schema injection closes gap (a) via in-session repair
 *
 * Run: nr test:manual -- test-issue-plan-codex-schema-repair-live
 *
 * Scenario: Codex has no `--json-schema` flag, so the plan prompt must carry
 * the real `resolutionPlanSchema` contract inline, and a schema-invalid first
 * pass must self-heal via a resumed `codex exec resume` turn — not fall
 * through to the platform-billed OpenAI completions repair.
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
 *   1. The command exits 0 and writes a valid plan artifact.
 *   2. The fake Codex binary is invoked exactly twice.
 *   3. The first invocation's prompt contains `Output contract` and the
 *      literal schema fields `"stepIndices"`/`"phases"` (the injected
 *      resolutionPlanSchema).
 *   4. The second invocation resumes the thread id from pass 1's
 *      `thread.started` message.
 *   5. The second invocation's prompt contains `did not validate` and a
 *      `Field: 'steps'` Zod diagnostic.
 *   6. The plan artifact's summary reflects the repaired (pass 2) content.
 *
 * Wire up: write a temporary `wf.config.js`, a `source.md` file, and a fake
 * `codex`/`Codex` executable pair that emits phase-nested (schema-invalid)
 * JSON on its first invocation and valid plan JSON when resumed. Run the
 * built CLI from `dist/main.js` against the temp repo.
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

const validPlanJson = JSON.stringify({
  action: 'fix',
  summary: 'Repaired plan',
  steps: ['Step 1'],
  estimatedComplexity: 'low',
  affectedRepositories: ['repo'],
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
    console.log(JSON.stringify({ type: 'thread.started', thread_id: 'tid-1' }));
    console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: ${JSON.stringify(incidentShapeJson)} } }));
  } else {
    console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: ${JSON.stringify(validPlanJson)} } }));
  }
});
`;

async function main(): Promise<void> {
  if (!fs.existsSync(distMainPath)) {
    fail('dist/main.js must exist before running this smoke test', 'Run `yarn build` first.');
    process.exit(1);
  }

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-codex-schema-repair-'));
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

    if (invocations.length === 2) {
      pass('fake Codex binary was invoked exactly twice');
    } else {
      fail('expected exactly 2 Codex invocations', `got ${invocations.length}: ${JSON.stringify(invocations)}`);
    }

    const firstPrompt = prompts[0] ?? '';
    if (firstPrompt.includes('Output contract') && firstPrompt.includes('"stepIndices"') && firstPrompt.includes('"phases"')) {
      pass('first invocation prompt carries the injected JSON Schema');
    } else {
      fail('first invocation prompt should contain the JSON Schema', firstPrompt.slice(0, 500));
    }

    if (invocations[1] && invocations[1].includes('resume') && invocations[1].includes('tid-1')) {
      pass('second invocation resumes thread id tid-1');
    } else {
      fail('second invocation should resume tid-1', JSON.stringify(invocations[1]));
    }

    const secondPrompt = prompts[1] ?? '';
    if (secondPrompt.includes('did not validate') && secondPrompt.includes("Field: 'steps'")) {
      pass('second invocation prompt carries the corrective Zod diagnostic');
    } else {
      fail('second invocation prompt should contain the retry diagnostic', secondPrompt.slice(0, 500));
    }

    if (fs.existsSync(planPath)) {
      const artifact = JSON.parse(fs.readFileSync(planPath, 'utf-8'));
      if (artifact.summary === 'Repaired plan') {
        pass('plan artifact reflects the repaired (pass 2) content');
      } else {
        fail('plan artifact should reflect repaired content', JSON.stringify(artifact.summary));
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
