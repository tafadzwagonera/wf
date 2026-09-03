import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { NestFactory } from '@nestjs/core';
import chalk from 'chalk';
import { AppModule } from '../../src/app.module';
import { PlanStepVerificationService } from '../../src/agents/plan-step-verification.service';
import { AiService } from '../../src/integrations/ai/ai.service';
import { getWfLogDir } from '../../src/shared/utils/wf-paths';
import { createReporter } from './support/reporter';

const { counts, pass, fail } = createReporter();

const git = (dir: string, args: string[]) =>
  execFileSync('git', args, { cwd: dir, encoding: 'utf-8' }).trim();

function todaysLogPath(): string {
  const date = new Date().toISOString().slice(0, 10);
  return path.join(getWfLogDir(), `agent-${date}.log`);
}

function makeRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'step-verify-stall-'));
  git(dir, ['init', '-q', '-b', 'master']);
  git(dir, ['config', 'user.email', 'test@example.com']);
  git(dir, ['config', 'user.name', 'Test']);
  fs.writeFileSync(path.join(dir, 'a.ts'), 'v1\n');
  git(dir, ['add', '.']);
  git(dir, ['commit', '-q', '-m', 'baseline']);
  fs.writeFileSync(path.join(dir, 'a.ts'), 'v2\n');
  return dir;
}

async function main(): Promise<void> {
  console.log('Manual smoke: sliding window stall detection terminates when pending count plateaus\n');

  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error'] });
  const service = app.get(PlanStepVerificationService);
  const aiService = app.get(AiService);
  const originalExecute = aiService.execute.bind(aiService);

  const repoDir = makeRepo();
  const logPath = todaysLogPath();

  // Assertions 1–4: pending count stays at 1 for 2 rounds (stallWindow=2) — loop
  // exits without running a fix round on the second stall detection
  let refreshCallsA = 0;
  let fixCallsA = 0;
  const logSizeA = fs.existsSync(logPath) ? fs.statSync(logPath).size : 0;

  (aiService as any).execute = async () => ({
    content: JSON.stringify({ statuses: [{ index: 0, status: 'not-done', missing: 'impl' }] }),
  });

  const outcomeA = await service.run({
    steps: ['Step A'],
    planSummary: 'stall-on-plateau smoke test',
    repoDir,
    sessionId: 'sess-stall',
    stallWindow: 2,
    silent: true,
    runFixRound: async () => {
      fixCallsA++;
      return { sessionId: 'sess-stall' };
    },
    refreshSteps: async () => {
      refreshCallsA++;
      return ['Step A'];
    },
  });

  const logA = fs.readFileSync(logPath, 'utf-8').slice(logSizeA);

  if (refreshCallsA === 2) {
    pass('refreshSteps called twice (stallWindow rounds)');
  } else {
    fail('Expected refreshSteps to be called 2 times (stallWindow)', 'actual: ' + refreshCallsA);
  }

  if (logA.includes('step-verify.stalled pending=1')) {
    pass('step-verify.stalled pending=1 logged at WARN');
  } else {
    fail('Expected step-verify.stalled pending=1 in the log', logA.slice(0, 500));
  }

  if (outcomeA.summary?.pending === 1) {
    pass('outcome.summary.pending is 1 — stalled with one pending step');
  } else {
    fail('Expected outcome.summary.pending to be 1', JSON.stringify(outcomeA.summary));
  }

  if (fixCallsA === 1) {
    pass('runFixRound was called once — before stall detected');
  } else {
    fail('Expected runFixRound to be called once', 'called ' + fixCallsA + ' time(s)');
  }

  // Assertion 5: pending count decreases over time — loop should complete without stalling
  let refreshCallsB = 0;
  let assessmentRoundB = 0;
  const logSizeB = fs.existsSync(logPath) ? fs.statSync(logPath).size : 0;

  (aiService as any).execute = async () => {
    assessmentRoundB++;
    if (assessmentRoundB === 1) {
      return { content: JSON.stringify({ statuses: [{ index: 0, status: 'not-done', missing: 'impl' }] }) };
    }
    return { content: JSON.stringify({ statuses: [{ index: 0, status: 'done' }] }) };
  };

  await service.run({
    steps: ['Step A'],
    planSummary: 'pending decreases — does not stall',
    repoDir,
    sessionId: 'sess-continue',
    stallWindow: 3,
    silent: true,
    runFixRound: async () => ({ sessionId: 'sess-continue' }),
    refreshSteps: async () => {
      refreshCallsB++;
      return ['Step A variant ' + refreshCallsB];
    },
  });

  const logB = fs.readFileSync(logPath, 'utf-8').slice(logSizeB);

  if (refreshCallsB >= 2 && logB.includes('step-verify.complete')) {
    pass('Pending count decreased over time — loop completed without stalling');
  } else {
    fail(
      'Expected loop to complete when pending decreases',
      'refreshCallsB=' + refreshCallsB + ' log=' + logB.slice(0, 300),
    );
  }

  (aiService as any).execute = originalExecute;
  fs.rmSync(repoDir, { recursive: true, force: true });

  console.log('\n' + counts.passed + ' passed, ' + counts.failed + ' failed');
  await app.close();
  if (counts.failed > 0) process.exit(1);
  console.log('\nManual smoke test passed: sliding window stall detection');
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
