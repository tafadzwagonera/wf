/**
 * Manual smoke test: missed steps are displayed to the user and logged at
 * exhaustion, not just a bare pending count
 *
 * Scenario: plan-step verification exhausts its single round with one step
 * still not-done. The user-facing output and the log file must show which
 * specific step was missed and why.
 *
 * Verifies:
 *   1. step-verify.exhausted pending=1 is logged at WARN
 *   2. step-verify.missed index=1 status=not-done missing=<reason> is logged
 *      at WARN (the specific missing reason, not just the count)
 *   3. CliPresenter.progress is called with the same missed-step line (visible
 *      to the user, not just buried in the log file)
 *   4. The returned outcome.summary equals { rounds: 1, done: 1, pending: 1 }
 *
 * Run: nr test:manual -- test-plan-step-verification-missed-steps-display
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
import { CliPresenter } from '../../src/shared/presentation/cli-presenter.service';
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
  console.log('Manual smoke: missed steps are displayed to the user and logged at exhaustion\n');

  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error'] });
  const planStepVerification = app.get(PlanStepVerificationService);
  const aiService = app.get(AiService);
  const presenter = app.get(CliPresenter);

  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'step-verify-missed-'));
  git(repoDir, ['init', '-q', '-b', 'master']);
  git(repoDir, ['config', 'user.email', 'test@example.com']);
  git(repoDir, ['config', 'user.name', 'Test']);
  fs.writeFileSync(path.join(repoDir, 'a.ts'), 'v1\n');
  fs.writeFileSync(path.join(repoDir, 'b.ts'), 'v1\n');
  git(repoDir, ['add', '.']);
  git(repoDir, ['commit', '-q', '-m', 'baseline']);
  fs.writeFileSync(path.join(repoDir, 'a.ts'), 'v2\n');
  fs.writeFileSync(path.join(repoDir, 'b.ts'), 'v2\n');

  const originalExecute = aiService.execute.bind(aiService);
  (aiService as any).execute = async () => ({
    content: JSON.stringify({
      statuses: [
        { index: 0, status: 'done' },
        { index: 1, status: 'not-done', missing: 'edge case for empty input' },
      ],
    }),
  });

  const progressCalls: string[] = [];
  const originalProgress = presenter.progress.bind(presenter);
  (presenter as any).progress = (line: string) => {
    progressCalls.push(line);
    return originalProgress(line);
  };

  const logPath = todaysLogPath();
  const logSizeBefore = fs.existsSync(logPath) ? fs.statSync(logPath).size : 0;

  const outcome = await planStepVerification.run({
    steps: ['Update a.ts', 'Update b.ts'],
    planSummary: 'missed steps smoke test',
    repoDir,
    sessionId: 'sess-1',
    maxRounds: 1,
    silent: false,
    runFixRound: async () => ({ sessionId: 'sess-1', passCount: 1 }),
  });

  const logContent = fs.readFileSync(logPath, 'utf-8').slice(logSizeBefore);

  if (logContent.includes('step-verify.exhausted pending=1')) {
    pass('step-verify.exhausted pending=1 logged at WARN');
  } else {
    fail('Expected step-verify.exhausted pending=1 in the log', logContent.slice(0, 500));
  }

  const missedLine = 'step-verify.missed index=1 status=not-done missing=edge case for empty input';
  if (logContent.includes(missedLine)) {
    pass('step-verify.missed logs the specific step index, status, and missing reason');
  } else {
    fail(`Expected "${missedLine}" in the log`, logContent.slice(0, 500));
  }

  if (progressCalls.some(line => line.includes(missedLine))) {
    pass('CliPresenter.progress surfaced the same missed-step line to the user');
  } else {
    fail('Expected a presenter.progress call containing the missed-step line', JSON.stringify(progressCalls));
  }

  if (JSON.stringify(outcome.summary) === JSON.stringify({ rounds: 1, done: 1, pending: 1 })) {
    pass('outcome.summary equals { rounds: 1, done: 1, pending: 1 }');
  } else {
    fail('Expected outcome.summary to equal { rounds: 1, done: 1, pending: 1 }', JSON.stringify(outcome.summary));
  }

  (aiService as any).execute = originalExecute;
  (presenter as any).progress = originalProgress;
  fs.rmSync(repoDir, { recursive: true, force: true });

  console.log(`\n${passed} passed, ${failed} failed`);
  await app.close();
  if (failed > 0) process.exit(1);
  console.log('\nManual smoke test passed: plan-step verification missed-steps display');
}

main().catch(error => {
  console.error(`\nManual smoke test failed: ${error.message}`);
  process.exit(1);
});
