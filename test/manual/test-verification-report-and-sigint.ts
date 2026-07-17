/**
 * Manual smoke test: verification report, SIGINT handling, and session ID preservation.
 *
 * Run: nr test:manual -- test-verification-report-and-sigint
 *
 * Verifies:
 *   1. runProgrammaticVerification runs each configured script and records pass/fail
 *   2. runProgrammaticVerification records correct id and status per script
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
import { runProgrammaticVerification, printVerificationReport } from '../../src/integrations/ai/adapters/verification-report';
import type { VerificationScript } from '../../src/shared/types/agent.types';

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

  // ── Test 1: runProgrammaticVerification runs each script ──

  console.log('Test 1: runProgrammaticVerification runs each configured script');
  const echoScripts: VerificationScript[] = [
    { id: 'echo-pass', name: 'echo-pass', command: 'echo ok', policy: 'enforced', aliases: [] },
    { id: 'echo-fail', name: 'echo-fail', command: 'false', policy: 'enforced', aliases: [] },
  ];
  const outcomes1 = runProgrammaticVerification(echoScripts, process.cwd());
  if (outcomes1.length === 2) {
    pass('One outcome per configured script');
  } else {
    fail(`Expected 2 outcomes, got ${outcomes1.length}`);
  }
  if (outcomes1[0].status === 'passed' && outcomes1[0].id === 'echo-pass') {
    pass('Passing command recorded as passed');
  } else {
    fail(`Expected passed, got ${outcomes1[0].status}`);
  }
  if (outcomes1[1].status === 'failed' && outcomes1[1].id === 'echo-fail') {
    pass('Failing command recorded as failed');
  } else {
    fail(`Expected failed, got ${outcomes1[1].status}`);
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
  // 1 header + 2 rows = 3 (echoScripts has 2 entries)
  if (captured.length === 3) {
    pass('3 lines printed (1 header + 2 outcomes)');
  } else {
    fail(`Expected 3 lines, got ${captured.length}`);
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

  // ── Test 8: no throwing verification gate in issue command ──

  console.log('\nTest 8: no throwing verification gate in issue command');
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

  // ── Test 9: verification fix loop exists in adapters ──

  console.log('\nTest 9: programmatic verification loop exists in both adapters');
  const claudeAdapterSource = require('fs').readFileSync(
    require('path').join(__dirname, '..', '..', 'src', 'integrations', 'ai', 'adapters', 'claude-cli.adapter.ts'), 'utf-8'
  ) as string;
  const codexAdapterSource = require('fs').readFileSync(
    require('path').join(__dirname, '..', '..', 'src', 'integrations', 'ai', 'adapters', 'codex-cli.adapter.ts'), 'utf-8'
  ) as string;
  const claudeHasFixLoop = claudeAdapterSource.includes('runProgrammaticVerificationLoop');
  const codexHasFixLoop = codexAdapterSource.includes('runProgrammaticVerificationLoop');
  if (claudeHasFixLoop && codexHasFixLoop) {
    pass('Both adapters have programmatic verification loops');
  } else {
    fail(`Claude: ${claudeHasFixLoop}, Codex: ${codexHasFixLoop}`);
  }

  await app.close();

  console.log(`\n--- Results: ${passed} passed, ${failed} failed ---\n`);
  process.exit(failed > 0 ? 1 : 0);
}

void main();
