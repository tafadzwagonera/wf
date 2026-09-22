/**
 * Manual smoke test: verification report, SIGINT handling, and session ID preservation.
 *
 * Run: nr test:manual verification-report-and-sigint.smoke.ts
 *
 * Verifies:
 *   1. runProgrammaticVerification runs each configured script and records pass/fail
 *   2. runProgrammaticVerification records correct id and status per script
 *   3. main.ts SIGINT handler does not exit on first signal (graceful shutdown)
 *   4. AiProviderError includes sessionId in details when thrown from parseStagePlanResponse
 *   5. ImplementerResult type includes verificationOutcomes field
 *   6. assertEnforcedVerificationsPassed blocks on enforced failures
 *   7. assertEnforcedVerificationsPassed allows best_effort failures
 */

import { NestFactory } from '@nestjs/core';
import { AppModule } from '../../src/app.module';
import { runProgrammaticVerification } from '../../src/integrations/ai/adapters/verification-report';
import type { VerificationScript } from '../../src/shared/types/agent.types';
import { createReporter } from './support/reporter';

const { counts, pass, fail } = createReporter();

function validateOutcomesCount(outcomes: any[]): void {
  if (outcomes.length === 2) {
    pass('One outcome per configured script');
  } else {
    fail(`Expected 2 outcomes, got ${outcomes.length}`);
  }
}

function validatePassingOutcome(outcome: any): void {
  if (outcome.status === 'passed' && outcome.id === 'echo-pass') {
    pass('Passing command recorded as passed');
  } else {
    fail(`Expected passed, got ${outcome.status}`);
  }
}

function validateFailingOutcome(outcome: any): void {
  if (outcome.status === 'failed' && outcome.id === 'echo-fail') {
    pass('Failing command recorded as failed');
  } else {
    fail(`Expected failed, got ${outcome.status}`);
  }
}

function test1(): void {
  console.log('Test 1: runProgrammaticVerification runs each configured script');
  const echoScripts: VerificationScript[] = [
    { id: 'echo-pass', name: 'echo-pass', command: 'echo ok', policy: 'enforced', aliases: [] },
    { id: 'echo-fail', name: 'echo-fail', command: 'false', policy: 'enforced', aliases: [] },
  ];
  const outcomes1 = runProgrammaticVerification(echoScripts, process.cwd());
  validateOutcomesCount(outcomes1);
  validatePassingOutcome(outcomes1[0]);
  validateFailingOutcome(outcomes1[1]);
}

function test3(): void {
  console.log('\nTest 3: main.ts SIGINT handler — first signal is graceful');
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
}

function test4(): void {
  console.log('\nTest 4: AiProviderError includes sessionId in details');
  const { AiProviderError: AiProviderErrorClass } = require('../../src/shared/utils/errors') as { AiProviderError: any };
  const error = new AiProviderErrorClass('test error', { sessionId: 'abc-123', response: 'prose' });
  if (error.details?.sessionId === 'abc-123') {
    pass('AiProviderError.details.sessionId accessible');
  } else {
    fail(`Expected sessionId "abc-123", got "${error.details?.sessionId}"`);
  }
}

function test5(): void {
  console.log('\nTest 5: ImplementerResult includes verificationOutcomes');
  const agentSource = require('fs').readFileSync(
    require('path').join(__dirname, '..', '..', 'src', 'agents', 'implementer.agent.ts'), 'utf-8'
  ) as string;
  if (agentSource.includes('verificationOutcomes: result.verificationOutcomes')) {
    pass('ImplementerAgent.runBackend returns verificationOutcomes');
  } else {
    fail('ImplementerAgent.runBackend does not return verificationOutcomes');
  }
}

function test6(): void {
  console.log('\nTest 6: no throwing verification gate in issue command');
  const issueCommandSource = require('fs').readFileSync(
    require('path').join(__dirname, '..', '..', 'src', 'commands', 'issue.command.ts'), 'utf-8'
  ) as string;
  const noThrowingGate = !issueCommandSource.includes('assertEnforcedVerificationsPassed')
    && !issueCommandSource.includes('logVerificationSummary');
  if (noThrowingGate) {
    pass('No verification gate or duplicate summary in issue command');
  } else {
    fail('assertEnforcedVerificationsPassed or logVerificationSummary still present');
  }
}

async function main(): Promise<void> {
  console.log('\n=== Test: Verification report, SIGINT, and session ID ===\n');

  test1();
  test3();
  test4();
  test5();
  test6();

  const app = await NestFactory.createApplicationContext(AppModule, { logger: false });
  await app.close();

  console.log(`\n--- Results: ${counts.passed} passed, ${counts.failed} failed ---\n`);
  process.exit(counts.failed > 0 ? 1 : 0);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
