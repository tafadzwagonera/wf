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
 * Run: nr test:manual -- cli-pass-outcome-log-level.smoke
 */

import { ConfigService } from '@nestjs/config';
import { StageAgentService } from '../../src/integrations/ai/stage-agent.service';
import * as cliRunner from '../../src/integrations/ai/adapters/claude-cli-runner';
import { getWfLogDir } from '../../src/shared/utils/wf-paths';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createReporter } from './support/reporter';

const { counts, pass, fail } = createReporter();

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
  const runId = String(Date.now());
  const successSessionId = `sess_ok_${runId}`;
  const unusableSessionId = `sess_bad_${runId}`;
  const validPlanResult = JSON.stringify({
    action: 'fix',
    summary: 'Smoke test plan',
    steps: ['Step 1'],
    estimatedComplexity: 'low',
  });

  // Scenario 1: a successful stream — valid structured result.
  await runOnce([
    {
      type: 'assistant', message: { content: [{ type: 'text', text: 'working...' }] }, session_id: successSessionId,
    },
    {
      type: 'result', result: validPlanResult, session_id: successSessionId, num_turns: 1, total_cost_usd: 0.01,
    },
  ]);
  let logContent = fs.readFileSync(logPath, 'utf-8');
  const successLinePattern = new RegExp(`\\[DEBUG\\].*cli\\.pass_outcome.*source=result.*session=${successSessionId}`);

  if (successLinePattern.test(logContent)) {
    pass('Successful pass logs cli.pass_outcome at DEBUG with source=result');
  } else {
    fail('Expected a DEBUG cli.pass_outcome source=result line', logContent.slice(-1000));
  }
  if (new RegExp(`cli\\.pass_unusable.*session=${successSessionId}`).test(logContent)) {
    fail('Did not expect cli.pass_unusable for a successful pass', logContent.slice(-1000));
  } else {
    pass('Successful pass does NOT log cli.pass_unusable');
  }

  // Scenario 2: assistant-text-only stream — genuinely unusable.
  await runOnce([
    { type: 'assistant', message: { content: [{ type: 'text', text: 'Still thinking...' }] }, session_id: unusableSessionId },
  ]);
  logContent = fs.readFileSync(logPath, 'utf-8');
  const unusableLinePattern = new RegExp(`\\[WARN\\].*cli\\.pass_unusable.*source=assistant_text.*session=${unusableSessionId}`);

  if (unusableLinePattern.test(logContent)) {
    pass('Assistant-text-only pass logs cli.pass_unusable at WARN with source=assistant_text');
  } else {
    fail('Expected a WARN cli.pass_unusable source=assistant_text line', logContent.slice(-1000));
  }

  (cliRunner as Record<string, unknown>).assertClaudeCliAvailable = originalAssert;
  (cliRunner as Record<string, unknown>).buildCliArgs = originalBuild;
  (cliRunner as Record<string, unknown>).spawnCli = originalSpawn;

  console.log(`\n${counts.passed} passed, ${counts.failed} failed`);
  if (counts.failed > 0) process.exit(1);
  console.log('\nManual smoke test passed: cli.pass_outcome log level');
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
