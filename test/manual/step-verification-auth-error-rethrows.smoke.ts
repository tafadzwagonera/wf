/**
 * Manual smoke test: step-verification re-throws AiProviderError with category 'auth'.
 *
 * Run: nr test:manual -- step-verification-auth-error-rethrows.smoke
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../../src/app.module';
import { PlanStepVerificationService } from '../../src/agents/plan-step-verification.service';
import { AiService } from '../../src/integrations/ai/ai.service';
import { AiProviderError, isAiProviderErrorLike } from '../../src/shared/utils/errors';
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'step-verify-auth-'));
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
  console.log('Manual smoke: auth error escapes the verification loop immediately\n');

  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error'] });
  const service = app.get(PlanStepVerificationService);
  const aiService = app.get(AiService);
  const repoDir = makeRepo();
  const logPath = todaysLogPath();
  const logOffset = fs.existsSync(logPath) ? fs.statSync(logPath).size : 0;

  const originalExecute = aiService.execute.bind(aiService);
  (aiService as any).execute = async () => {
    throw new AiProviderError('401 Unauthorized', undefined, false, 'auth');
  };

  let caughtError: unknown;
  try {
    await service.run({
      steps: ['Step A'],
      planSummary: 'auth rethrow smoke test',
      repoDir,
      sessionId: 'sess-auth',
      stallWindow: 3,
      silent: true,
      runFixRound: async () => ({ sessionId: 'sess-auth' }),
      refreshSteps: async () => ['Step A'],
    });
  } catch (err) {
    caughtError = err;
  }

  const log = fs.readFileSync(logPath, 'utf-8').slice(logOffset);

  if (caughtError !== undefined) {
    pass('service.run rejected — auth error escaped the loop');
  } else {
    fail('expected service.run to reject, but it resolved');
  }

  if (isAiProviderErrorLike(caughtError) && (caughtError as AiProviderError).category === 'auth') {
    pass('caught error is an AiProviderError with category auth');
  } else {
    fail('expected an AiProviderError with category auth', String(caughtError));
  }

  if (log.includes('step-verify.exhausted')) {
    fail('step-verify.exhausted should not appear when auth error is rethrown', log.slice(0, 600));
  } else {
    pass('step-verify.exhausted was NOT emitted — loop exited via rethrow, not exhaustion');
  }

  (aiService as any).execute = originalExecute;
  fs.rmSync(repoDir, { recursive: true, force: true });
  await app.close();

  console.log(`\n${counts.passed} passed, ${counts.failed} failed`);
  if (counts.failed > 0) process.exit(1);
  console.log('\nManual smoke test passed: auth error rethrows from verification loop');
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
