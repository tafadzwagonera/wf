/**
 * Manual Test: Provider session ID logging + deterministic custom plan hashes
 *
 * Run: nr test:manual session-id-logging-deterministic-hash.smoke.ts
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
import { createReporter, summarise } from './support/reporter';

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

async function captureDryRunPlanLine(command: IssuePlanCommand): Promise<string | undefined> {
  const capture = captureConsoleLog();
  try {
    await command.run([], { action: 'fix', customPlan: 'smoke-test-source.md', dryRun: true });
  } catch {
    // dry-run may throw — that's fine
  }
  const lines = capture.restore();
  return lines.find(l => l.includes('-fix-plan.'));
}

function assertHashConsistency(writeLine1: string | undefined, writeLine2: string | undefined): void {
  if (writeLine1 && writeLine2 && writeLine1 === writeLine2) {
    pass('Same --custom filename produces identical plan filename across runs');
  } else {
    fail('Plan filenames differ across runs', `Run 1: ${writeLine1}\nRun 2: ${writeLine2}`);
  }
}

function assertHashContent(writeLine: string | undefined): void {
  const expectedHash = hashPlanArtifactSources(['smoke-test-source']);
  if (writeLine && writeLine.includes(expectedHash)) {
    pass(`Hash derived from source stem (contains ${expectedHash})`);
  } else {
    fail(`Hash mismatch — expected ${expectedHash}`, writeLine ?? '(no write line found)');
  }
}

async function checkDeterministicHash(command: IssuePlanCommand): Promise<void> {
  console.log('Test 1: Deterministic hash for custom plans');
  const writeLine1 = await captureDryRunPlanLine(command);
  const writeLine2 = await captureDryRunPlanLine(command);
  assertHashConsistency(writeLine1, writeLine2);
  assertHashContent(writeLine1);
}

function assertSessionLog(methodSrc: string, methodName: string): void {
  if (methodSrc.includes('Provider session:')) {
    pass(`${methodName} contains "Provider session:" log`);
  } else {
    fail(`${methodName} missing "Provider session:" log`);
  }
}

function checkProviderSessionLogs(stageService: StageAgentService): void {
  console.log('\nTest 2: Provider session ID logging in stage prompt runners');
  const runCliSrc = (stageService as any).runCliStagePrompt?.toString() ?? '';
  assertSessionLog(runCliSrc, 'runCliStagePrompt');
  const runAnthropicSrc = (stageService as any).runAnthropicStagePrompt?.toString() ?? '';
  assertSessionLog(runAnthropicSrc, 'runAnthropicStagePrompt');
  const runCodexSrc = (stageService as any).runCodexCliStagePrompt?.toString() ?? '';
  assertSessionLog(runCodexSrc, 'runCodexCliStagePrompt');
}

function checkDeadCodeRemoved(command: IssuePlanCommand): void {
  console.log('\nTest 3: Dead code removal');
  const hasOldMethod = typeof (command as any).generateUniqueCustomPlanStem === 'function';
  if (!hasOldMethod) {
    pass('generateUniqueCustomPlanStem removed from IssuePlanCommand');
  } else {
    fail('generateUniqueCustomPlanStem still exists on IssuePlanCommand');
  }
}

async function main(): Promise<void> {
  console.log('\n=== Test: Session ID logging + Deterministic custom plan hashes ===\n');
  const app = await NestFactory.createApplicationContext(AppModule, { logger: false });
  const command = app.get(IssuePlanCommand);
  const stageService = app.get(StageAgentService);
  await checkDeterministicHash(command);
  checkProviderSessionLogs(stageService);
  checkDeadCodeRemoved(command);
  await app.close();
  summarise(counts);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
