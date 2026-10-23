/**
 * Manual Test: Agent SDK stage in the SEA binary needs claude on PATH
 *
 * Run: nr test:manual sea-binary-agent-sdk-requires-claude-on-path.smoke
 * Precondition: yarn build:sea
 *
 * Verifies (stage config: backend 'agent', provider 'anthropic', API base URL pointing at a closed port):
 *   1. No claude on PATH: exit 1 with "`claude` was not found on PATH" and "Install Claude Code"
 *   2. No network call is attempted before that error
 *   3. claude is a .js script and node is not on PATH: exit 1 naming the script and "needs `node` on PATH"
 *   4. Control: an executable shell-script claude gets past both errors
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { cleanupHarness, setupImplementHarness, type ImplementHarness } from './support/implement-cli-harness';
import { assertNodeAbsentFromCleanPath, assertSeaBinaryBuilt, cleanPath, seaBinaryPath } from './support/sea-binary-harness';
import { createReporter, summarise } from './support/reporter';

const { counts, pass, fail } = createReporter();

const check = (condition: boolean, message: string, detail?: string): void => {
  if (condition) pass(message);
  else fail(message, detail);
};

const agentConfig = [
  'module.exports = {',
  "  ai: [{ provider: 'anthropic', model: 'claude-sonnet-4-6', default: true, apiKey: 'test-key' }],",
  "  stages: { implement: { provider: 'anthropic', backend: 'agent' } },",
  '};',
  '',
].join('\n');

const createAgentHarness = (): ImplementHarness => {
  const harness = setupImplementHarness('sea-agent-', 'noop', ['src/a.ts']);
  fs.writeFileSync(path.join(harness.repoDir, 'wf.config.js'), agentConfig);
  fs.rmSync(path.join(harness.binDir, 'claude'));
  return harness;
};

const runAgentStage = (harness: ImplementHarness, pathDirs: string[]): { exitCode: number | null; output: string } => {
  const result = spawnSync(
    seaBinaryPath,
    ['issue:implement', harness.planPath, '--silent', '--no-branch', '--skip-install'],
    {
      cwd: harness.repoDir,
      env: { HOME: harness.homeDir, PATH: pathDirs.join(':'), ANTHROPIC_BASE_URL: 'http://127.0.0.1:9' },
      encoding: 'utf-8',
      maxBuffer: 1024 * 1024 * 10,
      timeout: 90_000,
    },
  );
  return { exitCode: result.status, output: `${result.stdout ?? ''}\n${result.stderr ?? ''}` };
};

const withHarness = (scenario: (harness: ImplementHarness) => void): void => {
  const harness = createAgentHarness();
  try {
    scenario(harness);
  } finally {
    cleanupHarness(harness);
  }
};

function checkMissingClaude(): void {
  withHarness(harness => {
    const run = runAgentStage(harness, [harness.binDir, ...cleanPath.split(':')]);
    const tail = run.output.slice(-600);
    check(run.exitCode === 1, 'missing claude exits 1', `exit ${run.exitCode}: ${tail}`);
    check(run.output.includes('`claude` was not found on PATH') && run.output.includes('Install Claude Code'),
      'error says claude was not found on PATH and how to fix it', tail);
    check(!/ECONNREFUSED|fetch failed/i.test(run.output), 'no network call attempted before the error', tail);
  });
}

function checkScriptClaudeWithoutNode(): void {
  withHarness(harness => {
    const scriptPath = path.join(harness.binDir, 'claude');
    const jsPath = path.join(harness.binDir, 'claude-real.js');
    fs.writeFileSync(jsPath, "console.log('fake');\n", { mode: 0o755 });
    fs.symlinkSync(jsPath, scriptPath);
    const run = runAgentStage(harness, [harness.binDir, ...cleanPath.split(':')]);
    check(run.exitCode === 1 && run.output.includes(jsPath) && run.output.includes('needs `node` on PATH'),
      'script claude without node names the script and the node requirement', run.output.slice(-600));
  });
}

function checkNativeStyleClaudeGetsPastErrors(): void {
  withHarness(harness => {
    fs.writeFileSync(path.join(harness.binDir, 'claude'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    const run = runAgentStage(harness, [harness.binDir, ...cleanPath.split(':')]);
    check(!run.output.includes('was not found on PATH') && !run.output.includes('needs `node` on PATH'),
      'executable claude passes the resolution checks', run.output.slice(-600));
  });
}

function main(): void {
  assertSeaBinaryBuilt();
  assertNodeAbsentFromCleanPath();
  console.log('\n SEA binary: Agent SDK needs claude on PATH\n');
  checkMissingClaude();
  checkScriptClaudeWithoutNode();
  checkNativeStyleClaudeGetsPastErrors();
  summarise(counts);
}

main();
