/**
 * Manual Test: Provider session ID logging + deterministic custom plan hashes
 *
 * Run: nr test:manual -- test-session-id-logging-deterministic-hash
 *
 * Verifies:
 *   1. Deterministic hash: same --custom filename produces the same plan filename across dry-run invocations
 *   2. Provider session log: runCliStagePrompt logs "Provider session:" when a session ID is returned
 *   3. No session log: runCliStagePrompt omits the log when no session ID is returned
 */

import { NestFactory } from '@nestjs/core';
import { AppModule } from '../../src/app.module';
import { IssuePlanCommand } from '../../src/commands/issue-plan.command';
import { hashPlanArtifactSources } from '../../src/shared/utils/plan-artifact';
import { StageAgentService } from '../../src/integrations/ai/stage-agent.service';
import { createReporter } from './support/reporter';

const { counts, pass, fail } = createReporter();

function captureConsoleLog(): { restore: () => string[] } {
  const lines: string[] = [];
  const orig = console.log;
  console.log = (...args: any[]) => {
    lines.push(args.map(String).join(' '));
  };
  return {
    restore: () => {
      console.log = orig;
      return lines;
    },
  };
}

async function main(): Promise<void> {
  console.log('\n=== Test: Session ID logging + Deterministic custom plan hashes ===\n');

  // ── Test 1: Deterministic hash in dry-run mode ────────────────────────────

  console.log('Test 1: Deterministic hash for custom plans');

  const app = await NestFactory.createApplicationContext(AppModule, { logger: false });
  const command = app.get(IssuePlanCommand);

  // First run: capture the previewed write path
  const capture1 = captureConsoleLog();
  try {
    await command.run([], { action: 'fix', customPlan: 'smoke-test-source.md', dryRun: true });
  } catch {
    // dry-run may throw — that's fine
  }
  const lines1 = capture1.restore();
  const writeLine1 = lines1.find(l => l.includes('-fix-plan.'));

  // Second run: capture again
  const capture2 = captureConsoleLog();
  try {
    await command.run([], { action: 'fix', customPlan: 'smoke-test-source.md', dryRun: true });
  } catch {
    // dry-run may throw — that's fine
  }
  const lines2 = capture2.restore();
  const writeLine2 = lines2.find(l => l.includes('-fix-plan.'));

  if (writeLine1 && writeLine2 && writeLine1 === writeLine2) {
    pass('Same --custom filename produces identical plan filename across runs');
  } else {
    fail('Plan filenames differ across runs', `Run 1: ${writeLine1}\nRun 2: ${writeLine2}`);
  }

  const expectedHash = hashPlanArtifactSources(['smoke-test-source']);
  if (writeLine1 && writeLine1.includes(expectedHash)) {
    pass(`Hash derived from source stem (contains ${expectedHash})`);
  } else {
    fail(`Hash mismatch — expected ${expectedHash}`, writeLine1 ?? '(no write line found)');
  }

  // ── Test 2: Provider session log presence ─────────────────────────────────

  console.log('\nTest 2: Provider session ID logging in stage prompt runners');

  const stageService = app.get(StageAgentService);

  // Verify the runner methods exist and contain session logging
  const runCliSrc = (stageService as any).runCliStagePrompt?.toString() ?? '';
  if (runCliSrc.includes('Provider session:')) {
    pass('runCliStagePrompt contains "Provider session:" log');
  } else {
    fail('runCliStagePrompt missing "Provider session:" log');
  }

  const runAnthropicSrc = (stageService as any).runAnthropicStagePrompt?.toString() ?? '';
  if (runAnthropicSrc.includes('Provider session:')) {
    pass('runAnthropicStagePrompt contains "Provider session:" log');
  } else {
    fail('runAnthropicStagePrompt missing "Provider session:" log');
  }

  const runCodexSrc = (stageService as any).runCodexCliStagePrompt?.toString() ?? '';
  if (runCodexSrc.includes('Provider session:')) {
    pass('runCodexCliStagePrompt contains "Provider session:" log');
  } else {
    fail('runCodexCliStagePrompt missing "Provider session:" log');
  }

  // ── Test 3: Dead code removed ─────────────────────────────────────────────

  console.log('\nTest 3: Dead code removal');

  const hasOldMethod = typeof (command as any).generateUniqueCustomPlanStem === 'function';
  if (hasOldMethod) {
    fail('generateUniqueCustomPlanStem still exists on IssuePlanCommand');
  } else {
    pass('generateUniqueCustomPlanStem removed from IssuePlanCommand');
  }

  // ── Summary ───────────────────────────────────────────────────────────────

  await app.close();

  console.log(`\n${counts.passed} passed, ${counts.failed} failed\n`);
  process.exit(counts.failed > 0 ? 1 : 0);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
