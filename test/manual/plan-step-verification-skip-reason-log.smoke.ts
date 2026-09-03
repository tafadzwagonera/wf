/**
 * Smoke test: plan-step verification skip emits a reason-bearing log entry
 *
 * Run: nr test:manual -- plan-step-verification-skip-reason-log
 *
 * Scenario: runPlanStepVerification previously returned silently when any skip
 * condition was met. The fix calls PlanStepVerificationService.logSkip(reason),
 * which writes 'step-verify.skipped reason=<reason>' to the on-disk log so skips
 * are diagnosable rather than silent.
 *
 * Note: plan-step-verification-commit-policy-skip.smoke.ts assertion 4 checks that
 * NO 'step-verify.*' log lines appear after a commit-policy skip. That assertion is
 * now incorrect — logSkip writes 'step-verify.skipped reason=commit-policy-allows-direct-commit'
 * on every commit-policy skip. That test's assertion 4 has been updated accordingly.
 *
 * Verify:
 *   1. cfg.enabled === false  → log contains 'step-verify.skipped reason=disabled'
 *   2. result.hasChanges === false → log contains 'step-verify.skipped reason=no-changes'
 *   3. all steps generic in multi-repo mode → 'step-verify.skipped reason=no-assessed-steps'
 *   4. options.isNewRepo === true → log contains 'step-verify.skipped reason=new-repo'
 *   5. estimatedComplexity === 'low' → 'step-verify.skipped reason=commit-policy-allows-direct-commit'
 *   6. PlanStepVerificationService.run is NOT called in any of the above cases
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { NestFactory } from '@nestjs/core';
import chalk from 'chalk';
import { AppModule } from '../../src/app.module';
import { ImplementerAgent } from '../../src/agents/implementer.agent';
import { PlanStepVerificationService } from '../../src/agents/plan-step-verification.service';
import { ConfigService } from '@nestjs/config';
import { getWfLogDir } from '../../src/shared/utils/wf-paths';
import type { PlanArtifact, TicketArtifact } from '../../src/agents/interfaces';
import { createReporter } from './support/reporter';

const { counts, pass, fail } = createReporter();

const git = (dir: string, args: string[]): void => {
  execFileSync('git', args, { cwd: dir, encoding: 'utf-8' });
};

function todaysLogPath(): string {
  const date = new Date().toISOString().slice(0, 10);
  return path.join(getWfLogDir(), `agent-${date}.log`);
}

function logSliceSince(offset: number): string {
  const logPath = todaysLogPath();
  if (!fs.existsSync(logPath)) return '';
  return fs.readFileSync(logPath, 'utf-8').slice(offset);
}

function currentLogOffset(): number {
  const logPath = todaysLogPath();
  return fs.existsSync(logPath) ? fs.statSync(logPath).size : 0;
}

const ticket: TicketArtifact = { ticketKey: 'WBP-99', content: '# WBP-99', path: '/tmp/wbp-99.md' };

function makeSourcePlan(overrides: Partial<PlanArtifact['plan']> = {}): PlanArtifact {
  return {
    action: 'feature',
    path: '/tmp/plan.json',
    plan: {
      action: 'feature',
      summary: 'skip-reason smoke',
      steps: ['repo-a — in src/index.ts update export'],
      estimatedComplexity: 'high',
      affectedFiles: ['repo-a/src/index.ts'],
      affectedRepositories: ['repo-a'],
      risks: [],
      ...overrides,
    },
  };
}

async function main(): Promise<void> {
  console.log(chalk.bold.cyan('\nSmoke: plan-step verification skip emits reason log\n'));

  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-skip-reason-'));

  try {
    git(repoDir, ['init', '-q', '-b', 'master']);
    git(repoDir, ['config', 'user.email', 'test@example.com']);
    git(repoDir, ['config', 'user.name', 'Test']);
    fs.mkdirSync(path.join(repoDir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(repoDir, 'src', 'index.ts'), 'export const v = 1;\n');
    git(repoDir, ['add', '.']);
    git(repoDir, ['commit', '-q', '-m', 'baseline']);

    const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error'] });

    try {
      const implementer = app.get(ImplementerAgent);
      const planStepVerification = app.get(PlanStepVerificationService);
      const configService = app.get(ConfigService);

      let runCallCount = 0;
      const originalRun = planStepVerification.run.bind(planStepVerification);
      (planStepVerification as any).run = async (params: unknown) => {
        runCallCount++;
        return originalRun(params as any);
      };

      const resolved = { repoName: 'repo-a', repoDir, repoFiles: ['repo-a/src/index.ts'], contextFiles: [] };
      const implResult = {
        type: 'implementation' as const,
        hasChanges: true,
        branchName: 'feature/smoke',
        sessionId: 'sess-smoke',
        verificationOutcomes: [],
      };

      const call = async (
        plan: PlanArtifact, options: Record<string, unknown>, resultOverride?: Partial<typeof implResult>,
      ) =>
        (implementer as any).runPlanStepVerification(
          ticket, plan, { trackerName: 'jira', repoDir, silent: true, ...options },
          resolved, plan.plan.steps, { ...implResult, ...resultOverride }, null,
        );

      // 1. disabled
      const originalGet = configService.get.bind(configService);
      (configService as any).get = (key: string, fallback?: unknown) =>
        key === 'stages.implement.planStepVerification' ? { enabled: false } : originalGet(key, fallback);
      let offset = currentLogOffset();
      runCallCount = 0;
      await call(makeSourcePlan(), {});
      const slice1 = logSliceSince(offset);
      (configService as any).get = originalGet;

      if (slice1.includes('step-verify.skipped reason=disabled')) {
        pass("cfg.enabled=false → log contains 'step-verify.skipped reason=disabled'");
      } else {
        fail("expected 'step-verify.skipped reason=disabled' in log", slice1.slice(0, 200));
      }
      if (runCallCount === 0) {
        pass('planStepVerification.run not called when disabled');
      } else {
        fail('planStepVerification.run should not be called when disabled', String(runCallCount));
      }

      // 2. no-changes
      offset = currentLogOffset();
      runCallCount = 0;
      await call(makeSourcePlan(), {}, { hasChanges: false });
      const slice2 = logSliceSince(offset);

      if (slice2.includes('step-verify.skipped reason=no-changes')) {
        pass("hasChanges=false → log contains 'step-verify.skipped reason=no-changes'");
      } else {
        fail("expected 'step-verify.skipped reason=no-changes' in log", slice2.slice(0, 200));
      }
      if (runCallCount === 0) {
        pass('planStepVerification.run not called when no changes');
      } else {
        fail('planStepVerification.run should not be called when no changes', String(runCallCount));
      }

      // 3. no-assessed-steps (generic steps + multi-repo mode)
      offset = currentLogOffset();
      runCallCount = 0;
      await call(
        makeSourcePlan({ steps: ['Run the tests', 'Update CHANGELOG'] }),
        { additionalRepoDirs: ['/tmp/repo-b'] },
      );
      const slice3 = logSliceSince(offset);

      if (slice3.includes('step-verify.skipped reason=no-assessed-steps')) {
        pass("generic steps in multi-repo mode → log contains 'step-verify.skipped reason=no-assessed-steps'");
      } else {
        fail("expected 'step-verify.skipped reason=no-assessed-steps' in log", slice3.slice(0, 200));
      }
      if (runCallCount === 0) {
        pass('planStepVerification.run not called when no assessed steps');
      } else {
        fail('planStepVerification.run should not be called when no assessed steps', String(runCallCount));
      }

      // 4. new-repo
      offset = currentLogOffset();
      runCallCount = 0;
      await call(makeSourcePlan(), { isNewRepo: true });
      const slice4 = logSliceSince(offset);

      if (slice4.includes('step-verify.skipped reason=new-repo')) {
        pass("isNewRepo=true → log contains 'step-verify.skipped reason=new-repo'");
      } else {
        fail("expected 'step-verify.skipped reason=new-repo' in log", slice4.slice(0, 200));
      }
      if (runCallCount === 0) {
        pass('planStepVerification.run not called for new repo');
      } else {
        fail('planStepVerification.run should not be called for new repo', String(runCallCount));
      }

      // 5. commit-policy-allows-direct-commit (low complexity)
      offset = currentLogOffset();
      runCallCount = 0;
      await call(makeSourcePlan({ estimatedComplexity: 'low' }), {});
      const slice5 = logSliceSince(offset);

      if (slice5.includes('step-verify.skipped reason=commit-policy-allows-direct-commit')) {
        pass("low complexity → log contains 'step-verify.skipped reason=commit-policy-allows-direct-commit'");
      } else {
        fail("expected 'step-verify.skipped reason=commit-policy-allows-direct-commit' in log", slice5.slice(0, 200));
      }
      if (runCallCount === 0) {
        pass('planStepVerification.run not called when commit policy allows direct commit');
      } else {
        fail('planStepVerification.run should not be called when commit policy allows direct commit', String(runCallCount));
      }

      (planStepVerification as any).run = originalRun;
    } finally {
      await app.close();
    }
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }

  console.log(`\n${counts.passed} passed, ${counts.failed} failed`);
  if (counts.failed > 0) process.exit(1);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
