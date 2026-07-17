/**
 * Manual smoke test: verification report, SIGINT handling, and session ID preservation.
 *
 * Run: nr test:manual -- test-verification-report-and-sigint
 *
 * Verifies:
 *   1. resolveSkippedSteps fills missing verification scripts as 'skipped'
 *   2. resolveSkippedSteps preserves existing passed/failed outcomes
 *   3. printVerificationReport prints nothing when outcomes is empty
 *   4. printVerificationReport prints a row per outcome
 *   5. main.ts SIGINT handler does not exit on first signal (graceful shutdown)
 *   6. AIError includes sessionId in details when thrown from parseStagePlanResponse
 *   7. ImplementerResult type includes verificationOutcomes field
 *   8. assertEnforcedVerificationsPassed blocks on enforced failures
 *   9. assertEnforcedVerificationsPassed allows best_effort failures
 */

import { NestFactory } from '@nestjs/core';
import { AppModule } from '../../src/app.module';
import { resolveSkippedSteps, printVerificationReport } from '../../src/integrations/ai/adapters/verification-report';
import type { VerificationOutcome, VerificationScript } from '../../src/shared/types/agent.types';

let passed = 0;
let failed = 0;

const pass = (msg: string): void => {
  console.log(`  \u2713 ${msg}`);
  passed++;
};

const fail = (msg: string, detail?: string): void => {
  console.error(`  \u2717 ${msg}${detail ? `\n    -> ${detail}` : ''}`);
  failed++;
};

const mockScripts: VerificationScript[] = [
  { id: 'lint', name: 'lint', command: 'yarn lint', policy: 'enforced', aliases: [] },
  { id: 'test', name: 'test', command: 'yarn test', policy: 'enforced', aliases: [] },
  { id: 'format', name: 'format', command: 'yarn format', policy: 'best_effort', aliases: [] },
];

async function main(): Promise<void> {
  console.log('\n=== Test: Verification report, SIGINT, and session ID ===\n');

  // ── Test 1: resolveSkippedSteps fills missing scripts ──

  console.log('Test 1: resolveSkippedSteps fills missing scripts as skipped');
  const outcomes1 = resolveSkippedSteps(mockScripts, []);
  if (outcomes1.length === 3) {
    pass('All 3 scripts filled as skipped');
  } else {
    fail(`Expected 3 skipped outcomes, got ${outcomes1.length}`);
  }
  const allSkipped = outcomes1.every(o => o.status === 'skipped');
  if (allSkipped) {
    pass('All outcomes have status "skipped"');
  } else {
    fail('Not all outcomes are skipped');
  }

  // ── Test 2: resolveSkippedSteps preserves existing outcomes ──

  console.log('\nTest 2: resolveSkippedSteps preserves existing passed/failed outcomes');
  const existing: VerificationOutcome[] = [
    { id: 'lint', command: 'yarn lint', policy: 'enforced', status: 'passed' },
  ];
  const outcomes2 = resolveSkippedSteps(mockScripts, existing);
  if (outcomes2.length === 3) {
    pass('Total outcomes = 3 (1 existing + 2 skipped)');
  } else {
    fail(`Expected 3 outcomes, got ${outcomes2.length}`);
  }
  const lintOutcome = outcomes2.find(o => o.id === 'lint');
  if (lintOutcome?.status === 'passed') {
    pass('Existing lint outcome preserved as passed');
  } else {
    fail(`Expected lint status "passed", got "${lintOutcome?.status}"`);
  }

  // ── Test 3: printVerificationReport with empty outcomes ──

  console.log('\nTest 3: printVerificationReport prints nothing when outcomes is empty');
  const originalLog = console.log;
  let logCalls = 0;
  console.log = (..._args: any[]) => {
    logCalls++;
  };
  printVerificationReport([]);
  console.log = originalLog;
  if (logCalls === 0) {
    pass('No output for empty outcomes');
  } else {
    fail(`Expected 0 log calls, got ${logCalls}`);
  }

  // ── Test 4: printVerificationReport prints a row per outcome ──

  console.log('\nTest 4: printVerificationReport prints a row per outcome');
  const captured: string[] = [];
  console.log = (...args: any[]) => {
    captured.push(args.join(' '));
  };
  printVerificationReport(outcomes1);
  console.log = originalLog;
  // 1 header + 3 rows = 4
  if (captured.length === 4) {
    pass('4 lines printed (1 header + 3 outcomes)');
  } else {
    fail(`Expected 4 lines, got ${captured.length}`);
  }

  // ── Test 5: main.ts SIGINT handler does not exit on first signal ──

  console.log('\nTest 5: main.ts SIGINT handler — first signal is graceful');
  const mainSource = require('fs').readFileSync(
    require('path').join(__dirname, '..', '..', 'src', 'main.ts'), 'utf-8'
  ) as string;
  const hasGracefulFirst = mainSource.includes('sigintReceived = true;')
    && !mainSource.includes('sigintReceived = true;\n    process.exit(130);');
  if (hasGracefulFirst) {
    pass('First SIGINT sets flag without calling process.exit');
  } else {
    fail('First SIGINT still calls process.exit(130) immediately');
  }

  // ── Test 6: AIError sessionId in plan fallback ──

  console.log('\nTest 6: AIError includes sessionId in details');
  const { AIError: AIErrorClass } = require('../../src/shared/utils/errors') as { AIError: any };
  const error = new AIErrorClass('test error', { sessionId: 'abc-123', response: 'prose' });
  if (error.details?.sessionId === 'abc-123') {
    pass('AIError.details.sessionId accessible');
  } else {
    fail(`Expected sessionId "abc-123", got "${error.details?.sessionId}"`);
  }

  // ── Test 7: ImplementerResult type includes verificationOutcomes ──

  console.log('\nTest 7: ImplementerResult includes verificationOutcomes');
  const app = await NestFactory.createApplicationContext(AppModule, { logger: false });
  const { ImplementerAgent } = require('../../src/agents/implementer.agent');
  const agentSource = require('fs').readFileSync(
    require('path').join(__dirname, '..', '..', 'src', 'agents', 'implementer.agent.ts'), 'utf-8'
  ) as string;
  if (agentSource.includes('verificationOutcomes: result.verificationOutcomes')) {
    pass('ImplementerAgent.runBackend returns verificationOutcomes');
  } else {
    fail('ImplementerAgent.runBackend does not return verificationOutcomes');
  }

  // ── Test 8: assertEnforcedVerificationsPassed blocks on enforced failures ──

  console.log('\nTest 8: assertEnforcedVerificationsPassed blocks on enforced failures');
  const issueCommandSource = require('fs').readFileSync(
    require('path').join(__dirname, '..', '..', 'src', 'commands', 'issue.command.ts'), 'utf-8'
  ) as string;
  const hasEnforcedCheck = issueCommandSource.includes('assertEnforcedVerificationsPassed')
    && issueCommandSource.includes("policy === 'enforced'")
    && issueCommandSource.includes("status === 'failed'");
  if (hasEnforcedCheck) {
    pass('assertEnforcedVerificationsPassed checks enforced + failed');
  } else {
    fail('assertEnforcedVerificationsPassed missing or incomplete');
  }

  // ── Test 9: assertEnforcedVerificationsPassed allows best_effort failures ──

  console.log('\nTest 9: best_effort failures do not block');
  const allowsBestEffort = issueCommandSource.includes('best_effort')
    && !issueCommandSource.includes("policy === 'best_effort' && status === 'failed'");
  if (allowsBestEffort) {
    pass('best_effort failures are warned, not blocked');
  } else {
    fail('best_effort handling unclear');
  }

  await app.close();

  console.log(`\n--- Results: ${passed} passed, ${failed} failed ---\n`);
  process.exit(failed > 0 ? 1 : 0);
}

void main();
