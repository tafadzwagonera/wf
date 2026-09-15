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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'step-verify-cfail-'));
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
  console.log('Manual smoke: consecutive assessor failures terminate the loop after stallWindow rounds\n');

  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error'] });
  const service = app.get(PlanStepVerificationService);
  const aiService = app.get(AiService);
  const repoDir = makeRepo();

  const originalExecute = aiService.execute.bind(aiService);

  const logPath = todaysLogPath();

  (aiService as any).execute = async () => ({ content: 'not json' });
  let refreshCallsA = 0;
  let fixCallsA = 0;
  const logSizeA = fs.existsSync(logPath) ? fs.statSync(logPath).size : 0;

  const outcomeA = await service.run({
    steps: ['Step A'],
    planSummary: 'consecutive failure bound smoke test',
    repoDir,
    sessionId: 'sess-cfail',
    stallWindow: 2,
    silent: true,
    runFixRound: async () => {
      fixCallsA++;
      return { sessionId: 'sess-cfail' };
    },
    refreshSteps: async () => {
      refreshCallsA++;
      return [`Step A variant ${refreshCallsA}`];
    },
  });

  const logA = fs.readFileSync(logPath, 'utf-8').slice(logSizeA);

  if (refreshCallsA === 2) {
    pass('refreshSteps called exactly 2 times before the loop exited');
  } else {
    fail(`Expected refreshSteps called 2 times`, `actual: ${refreshCallsA}`);
  }

  if (logA.includes('assessor-failed-2-rounds-in-a-row') && logA.includes('stallWindow=2')) {
    pass('Consecutive-failure exhausted log emitted with correct failure count and stallWindow');
  } else {
    fail('Expected assessor-failed-2-rounds-in-a-row stallWindow=2 in log', logA.slice(0, 600));
  }

  if (outcomeA.summary === undefined) {
    pass('outcome.summary is undefined');
  } else {
    fail('Expected outcome.summary to be undefined', JSON.stringify(outcomeA.summary));
  }

  if (fixCallsA === 0) {
    pass('runFixRound was never called — loop exited before any fix round');
  } else {
    fail(`Expected runFixRound to not be called`, `called ${fixCallsA} time(s)`);
  }

  let refreshCallsB = 0;
  const logSizeB = fs.readFileSync(logPath).length;

  await service.run({
    steps: ['Step A'],
    planSummary: 'stall wins over failure',
    repoDir,
    sessionId: 'sess-stallwins',
    stallWindow: 2,
    silent: true,
    runFixRound: async () => ({ sessionId: 'sess-stallwins' }),
    refreshSteps: async () => {
      refreshCallsB++;
      return ['Step A'];
    },
  });

  const logB = fs.readFileSync(logPath, 'utf-8').slice(logSizeB);

  if (logB.includes('assessor-failed-2-rounds-in-a-row') && logB.includes('stallWindow=2')) {
    pass('Consecutive-failure limit fires when assessor fails across stallWindow rounds');
  } else {
    fail('Expected assessor-failed-2-rounds-in-a-row stallWindow=2 in log', logB.slice(0, 600));
  }

  (aiService as any).execute = originalExecute;
  fs.rmSync(repoDir, { recursive: true, force: true });

  console.log(`\n${counts.passed} passed, ${counts.failed} failed`);
  await app.close();
  if (counts.failed > 0) process.exit(1);
  console.log('\nManual smoke test passed: consecutive assessment failure bound');
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
