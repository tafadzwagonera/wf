/**
 * Manual smoke test: cli.pass_outcome vs cli.pass_unusable correctly
 * distinguishes a successful CLI pass from a failed one
 *
 * Scenario: a `claude` CLI stage pass that completes successfully (schema-
 * valid structured result) must log as cli.pass_outcome at DEBUG. Only a
 * genuinely unusable pass (no result, or content demoted from assistant_text)
 * should log as cli.pass_unusable at WARN. Before this fix, every pass —
 * success or not — logged cli.pass_unusable at WARN, misleadingly reading as
 * a failure even on success.
 *
 * Verifies:
 *   1. A successful stream (valid structured `result` message) logs
 *      cli.pass_outcome ... source=result at DEBUG — no cli.pass_unusable
 *      line for that pass
 *   2. An assistant-text-only stream (no usable result) logs
 *      cli.pass_unusable ... source=assistant_text at WARN
 *
 * Run: nr test:manual -- test-cli-pass-outcome-log-level
 */

import chalk from 'chalk';
import { ConfigService } from '@nestjs/config';
import { StageAgentService } from '../../src/integrations/ai/stage-agent.service';
import * as cliRunner from '../../src/integrations/ai/adapters/claude-cli-runner';
import { getWfLogDir } from '../../src/shared/utils/wf-paths';
import * as fs from 'fs';
import * as path from 'path';

let passed = 0;
let failed = 0;

const pass = (message: string) => {
  console.log(chalk.green(`  PASS  ${message}`));
  passed++;
};
const fail = (message: string, detail?: string) => {
  console.error(chalk.red(`  FAIL  ${message}${detail ? `\n    → ${detail}` : ''}`));
  failed++;
};

function todaysLogPath(): string {
  const date = new Date().toISOString().slice(0, 10);
  return path.join(getWfLogDir(), `agent-${date}.log`);
}

function createConfigService(): ConfigService {
  const values: Record<string, unknown> = {
    'stages.plan.backend': 'cli',
    'stages.plan.provider': 'anthropic',
    'stages.plan.model': 'claude-sonnet-4-6',
    'ai.provider': 'anthropic',
    'ai.model': 'claude-sonnet-4-6',
  };
  const get = (key: string, fallback?: unknown) => (key in values ? values[key] : fallback);
  return { get } as unknown as ConfigService;
}

async function main(): Promise<void> {
  console.log('Manual smoke: cli.pass_outcome vs cli.pass_unusable log level\n');

  const originalAssert = cliRunner.assertClaudeCliAvailable;
  const originalBuild = cliRunner.buildCliArgs;
  const originalSpawn = cliRunner.spawnCli;
  (cliRunner as Record<string, unknown>).assertClaudeCliAvailable = () => undefined;
  (cliRunner as Record<string, unknown>).buildCliArgs = () => ['-p', '--output-format', 'stream-json'];

  const runOnce = async (messages: Record<string, unknown>[]): Promise<void> => {
    (cliRunner as Record<string, unknown>).spawnCli = async function* () {
      for (const msg of messages) yield msg;
    };
    const service = new StageAgentService(createConfigService());
    const runner = (service as any).runCliStagePrompt.bind(service);
    await runner({ stage: 'plan', prompt: 'test', systemPrompt: 'sys' }).catch(() => undefined);
  };

  const logPath = todaysLogPath();

  // Scenario 1: a successful stream — valid structured result.
  let logSizeBefore = fs.existsSync(logPath) ? fs.statSync(logPath).size : 0;
  await runOnce([
    {
      type: 'assistant', message: { content: [{ type: 'text', text: 'working...' }] }, session_id: 'sess_ok',
    },
    {
      type: 'result', result: JSON.stringify({ ok: true }), session_id: 'sess_ok', num_turns: 1, total_cost_usd: 0.01,
    },
  ]);
  let logContent = fs.readFileSync(logPath, 'utf-8').slice(logSizeBefore);

  if (/\[DEBUG\].*cli\.pass_outcome.*source=result/.test(logContent)) {
    pass('Successful pass logs cli.pass_outcome at DEBUG with source=result');
  } else {
    fail('Expected a DEBUG cli.pass_outcome source=result line', logContent.slice(0, 500));
  }
  if (!logContent.includes('cli.pass_unusable')) {
    pass('Successful pass does NOT log cli.pass_unusable');
  } else {
    fail('Did not expect cli.pass_unusable for a successful pass', logContent.slice(0, 500));
  }

  // Scenario 2: assistant-text-only stream — genuinely unusable.
  logSizeBefore = fs.existsSync(logPath) ? fs.statSync(logPath).size : 0;
  await runOnce([
    { type: 'assistant', message: { content: [{ type: 'text', text: 'Still thinking...' }] }, session_id: 'sess_bad' },
  ]);
  logContent = fs.readFileSync(logPath, 'utf-8').slice(logSizeBefore);

  if (/\[WARN\].*cli\.pass_unusable.*source=assistant_text/.test(logContent)) {
    pass('Assistant-text-only pass logs cli.pass_unusable at WARN with source=assistant_text');
  } else {
    fail('Expected a WARN cli.pass_unusable source=assistant_text line', logContent.slice(0, 500));
  }

  (cliRunner as Record<string, unknown>).assertClaudeCliAvailable = originalAssert;
  (cliRunner as Record<string, unknown>).buildCliArgs = originalBuild;
  (cliRunner as Record<string, unknown>).spawnCli = originalSpawn;

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
  console.log('\nManual smoke test passed: cli.pass_outcome log level');
}

main().catch(error => {
  console.error(`\nManual smoke test failed: ${error.message}`);
  process.exit(1);
});
