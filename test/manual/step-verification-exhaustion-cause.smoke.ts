/**
 * Manual smoke test: step-verification exhaustion log includes the actual failure cause.
 *
 * Run: nr test:manual -- step-verification-exhaustion-cause.smoke
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { NestFactory } from '@nestjs/core';
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'step-verify-cause-'));
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
  console.log('Manual smoke: exhaustion log includes the actual failure cause\n');

  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error'] });
  const service = app.get(PlanStepVerificationService);
  const aiService = app.get(AiService);
  const repoDir = makeRepo();
  const logPath = todaysLogPath();
  const logOffset = fs.existsSync(logPath) ? fs.statSync(logPath).size : 0;

  const originalExecute = aiService.execute.bind(aiService);
  (aiService as any).execute = async () => {
    throw new Error('ECONN timed out');
  };

  let refreshCalls = 0;
  const outcome = await service.run({
    steps: ['Step A'],
    planSummary: 'exhaustion cause smoke test',
    repoDir,
    sessionId: 'sess-cause',
    stallWindow: 2,
    silent: true,
    runFixRound: async () => ({ sessionId: 'sess-cause' }),
    refreshSteps: async () => {
      refreshCalls++;
      return [`Step A v${refreshCalls}`];
    },
  });

  const log = fs.readFileSync(logPath, 'utf-8').slice(logOffset);

  if (log.includes('step-verify.exhausted') && log.includes('stallWindow=2')) {
    pass('exhaustion WARN log emitted with stallWindow=2');
  } else {
    fail('expected step-verify.exhausted stallWindow=2 in log', log.slice(0, 600));
  }

  if (log.includes('cause=ECONN timed out')) {
    pass('exhaustion log contains the actual error cause');
  } else {
    fail('expected cause=ECONN timed out in log', log.slice(0, 600));
  }

  if (!log.includes('assessor-returned-invalid-json')) {
    pass('exhaustion log does not contain the old hardcoded invalid-json label');
  } else {
    fail('log unexpectedly contains the old assessor-returned-invalid-json label', log.slice(0, 600));
  }

  if (outcome.summary === undefined) {
    pass('outcome.summary is undefined');
  } else {
    fail('expected outcome.summary to be undefined', JSON.stringify(outcome.summary));
  }

  (aiService as any).execute = originalExecute;
  fs.rmSync(repoDir, { recursive: true, force: true });
  await app.close();

  console.log(`\n${counts.passed} passed, ${counts.failed} failed`);
  if (counts.failed > 0) process.exit(1);
  console.log('\nManual smoke test passed: exhaustion cause surfaced in log');
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
