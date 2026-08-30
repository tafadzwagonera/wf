/**
 * Manual smoke test: an invalid step-assessment response continues to the
 * next round instead of aborting all rounds
 *
 * Scenario: the AI step assessor returns a malformed response (wrong
 * assessment count) on every attempt in round 1 of a 3-round budget. Before
 * this fix, a failed assessment aborted runVerificationLoop entirely — round
 * 1 exhausted the whole verification even though maxRounds=3. After the fix,
 * an invalid round falls through to round 2.
 *
 * Verifies:
 *   1. Round 1's assessment attempts return a validation error and log
 *      step-verify.assess.invalid — but the loop does NOT stop there
 *   2. step-verify.round.start round=2/3 is reached — proving the loop
 *      advanced instead of terminating after round 1
 *   3. Round 2 (stubbed to return a valid, fully-done response) resolves the
 *      outcome with summary.pending === 0 and summary.rounds === 2
 *   4. The raw malformed AI response body is recoverable from the log
 *      (step-verify.assess.raw-response), not silently swallowed
 *
 * Run: nr test:manual -- test-plan-step-verification-round-continuation
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { NestFactory } from '@nestjs/core';
import chalk from 'chalk';
import { AppModule } from '../../src/app.module';
import { PlanStepVerificationService } from '../../src/agents/plan-step-verification.service';
import { AiService } from '../../src/integrations/ai/ai.service';
import { getWfLogDir } from '../../src/shared/utils/wf-paths';

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

const git = (dir: string, args: string[]): string =>
  execFileSync('git', args, { cwd: dir, encoding: 'utf-8' }).trim();

function todaysLogPath(): string {
  const date = new Date().toISOString().slice(0, 10);
  return path.join(getWfLogDir(), `agent-${date}.log`);
}

async function main(): Promise<void> {
  console.log('Manual smoke: invalid assessment continues to next round instead of aborting all rounds\n');

  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error'] });
  const planStepVerification = app.get(PlanStepVerificationService);
  const aiService = app.get(AiService);

  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'step-verify-round-'));
  git(repoDir, ['init', '-q', '-b', 'master']);
  git(repoDir, ['config', 'user.email', 'test@example.com']);
  git(repoDir, ['config', 'user.name', 'Test']);
  fs.writeFileSync(path.join(repoDir, 'a.ts'), 'v1\n');
  git(repoDir, ['add', '.']);
  git(repoDir, ['commit', '-q', '-m', 'baseline']);
  fs.writeFileSync(path.join(repoDir, 'a.ts'), 'v2\n');

  let call = 0;
  const originalExecute = aiService.execute.bind(aiService);
  (aiService as any).execute = async (_request: unknown) => {
    call += 1;
    // Round 1: both attempts (call 1, 2) return a malformed response (wrong count).
    if (call <= 2) {
      return { content: JSON.stringify({ statuses: [{ index: 0, status: 'done' }, { index: 1, status: 'done' }] }) };
    }
    // Round 2 onward: a valid, fully-done response for the single real step.
    return { content: JSON.stringify({ statuses: [{ index: 0, status: 'done' }] }) };
  };

  const logPath = todaysLogPath();
  const logSizeBefore = fs.existsSync(logPath) ? fs.statSync(logPath).size : 0;

  const outcome = await planStepVerification.run({
    steps: ['Update a.ts'],
    planSummary: 'round continuation smoke test',
    repoDir,
    sessionId: 'sess-1',
    maxRounds: 3,
    silent: true,
    runFixRound: async () => ({ sessionId: 'sess-1', passCount: 1 }),
  });

  const logContent = fs.readFileSync(logPath, 'utf-8').slice(logSizeBefore);

  if (logContent.includes('step-verify.assess.invalid')) {
    pass('Round 1 logged step-verify.assess.invalid for the malformed response');
  } else {
    fail('Expected step-verify.assess.invalid in the log', logContent.slice(0, 500));
  }

  if (logContent.includes('step-verify.round.start round=2/3')) {
    pass('Loop advanced to round 2 instead of terminating after round 1\'s invalid assessment');
  } else {
    fail('Expected step-verify.round.start round=2/3 in the log', logContent.slice(0, 500));
  }

  if (outcome.summary?.pending === 0 && outcome.summary?.rounds === 2) {
    pass('Round 2 resolved the outcome: summary.pending=0, summary.rounds=2');
  } else {
    fail('Expected summary.pending=0 and summary.rounds=2', JSON.stringify(outcome.summary));
  }

  if (logContent.includes('step-verify.assess.raw-response body=')) {
    pass('Raw malformed AI response body is recoverable from the log');
  } else {
    fail('Expected step-verify.assess.raw-response in the log', logContent.slice(0, 500));
  }

  (aiService as any).execute = originalExecute;
  fs.rmSync(repoDir, { recursive: true, force: true });

  console.log(`\n${passed} passed, ${failed} failed`);
  await app.close();
  if (failed > 0) process.exit(1);
  console.log('\nManual smoke test passed: plan-step verification round continuation');
}

main().catch(error => {
  console.error(`\nManual smoke test failed: ${error.message}`);
  process.exit(1);
});
