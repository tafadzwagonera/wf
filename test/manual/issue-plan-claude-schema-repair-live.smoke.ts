/**
 * Manual smoke test: Claude CLI plan schema-miss repairs in-session via --resume
 *
 * Run: nr test:manual -- test-issue-plan-claude-schema-repair-live
 *
 * Scenario: Claude's CLI pass loop now validates JSON in-loop; a
 * schema-invalid pass 1 result must trigger exactly one resumed repair pass
 * carrying the stage-agnostic `cliRetryPrompt` — not a fresh, full-context
 * restart, and not a silent hand-off to the completions repair on the first
 * miss.
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
 *   2. The fake `claude` binary is invoked exactly twice.
 *   3. The second invocation's args include `--resume sess-1` matching the
 *      `session_id` from pass 1's stream-json output.
 *   4. The second invocation's piped prompt contains "JSON schema provided
 *      in the original instructions" (the reworded, stage-agnostic
 *      `cliRetryPrompt` — not the old "resolution plan schema" wording).
 *   5. The resulting plan's `summary` matches pass 2's payload, confirming
 *      the repaired content — not pass 1's invalid content — was used.
 *
 * Wire up: write a temp `wf.config.js`, `source.md`, and a fake `claude`
 * executable that reads the prompt from stdin and, on its first invocation,
 * emits schema-invalid plan JSON with `session_id: "sess-1"`; on
 * invocations carrying `--resume sess-1`, emits valid plan JSON instead.
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

const schemaInvalidPlanJson = JSON.stringify({ action: 'fix', summary: 'bad' });

const validPlanJson = JSON.stringify({
  action: 'fix',
  summary: 'Repaired via resume',
  steps: ['Step 1'],
  estimatedComplexity: 'low',
  affectedRepositories: ['repo'],
});

const buildFakeClaudeScript = (invocationLogPath: string): string => `#!/usr/bin/env node
const fs = require('fs');
const args = process.argv.slice(2);

fs.appendFileSync(${JSON.stringify(invocationLogPath)}, JSON.stringify(args) + '\\n');

const resumeIndex = args.indexOf('--resume');
const isResume = resumeIndex !== -1 && args[resumeIndex + 1] === 'sess-1';

let input = '';
process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('end', () => {
  fs.appendFileSync(${JSON.stringify(invocationLogPath)}.replace(/\\.log$/, '.prompts.log'), input + '\\n---\\n');

  const result = isResume ? ${JSON.stringify(validPlanJson)} : ${JSON.stringify(schemaInvalidPlanJson)};
  console.log(JSON.stringify({ type: 'result', subtype: 'success', result, session_id: 'sess-1' }));
});
`;

async function main(): Promise<void> {
  if (!fs.existsSync(distMainPath)) {
    fail('dist/main.js must exist before running this smoke test', 'Run `yarn build` first.');
    process.exit(1);
  }

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-claude-schema-repair-'));
  const homeDir = path.join(tempRoot, 'home');
  const repoDir = path.join(tempRoot, 'repo');
  const binDir = path.join(tempRoot, 'bin');
  const sourcePath = path.join(repoDir, 'source.md');
  const configPath = path.join(repoDir, 'wf.config.js');
  const claudeScriptPath = path.join(binDir, 'claude');
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
      pass('fake claude binary was invoked exactly twice');
    } else {
      fail('expected exactly 2 claude invocations', `got ${invocations.length}: ${JSON.stringify(invocations)}`);
    }

    const secondArgs = invocations[1] ?? [];
    if (secondArgs.includes('--resume') && secondArgs.includes('sess-1')) {
      pass('second invocation resumes session sess-1');
    } else {
      fail('second invocation should carry --resume sess-1', JSON.stringify(secondArgs));
    }

    const secondPrompt = prompts[1] ?? '';
    if (secondPrompt.includes('JSON schema provided in the original instructions')) {
      pass('second invocation prompt uses the stage-agnostic cliRetryPrompt wording');
    } else {
      fail('second invocation prompt should use the stage-agnostic retry wording', secondPrompt.slice(0, 500));
    }

    if (fs.existsSync(planPath)) {
      const artifact = JSON.parse(fs.readFileSync(planPath, 'utf-8'));
      if (artifact.summary === 'Repaired via resume') {
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
