/**
 * Manual smoke test: plan-step verification skips entirely when commit
 * policy allows commits (low-complexity / stage-and-commit-per-change)
 *
 * Verifies:
 *   1. resolveCommitPolicy('low').allowsCommit === true
 *   2. ImplementerAgent.runPlanStepVerification (real, DI-wired instance)
 *      skips the call to PlanStepVerificationService.run for a low-complexity
 *      plan, returning the result unchanged
 *   3. No stepVerification summary is attached to the returned result
 *   4. No step-verify.* lines are written to the on-disk log file for this run
 *
 * Run: nr test:manual -- test-plan-step-verification-commit-policy-skip
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { NestFactory } from '@nestjs/core';
import chalk from 'chalk';
import { AppModule } from '../../src/app.module';
import { ImplementerAgent } from '../../src/agents/implementer.agent';
import { PlanStepVerificationService } from '../../src/agents/plan-step-verification.service';
import { resolveCommitPolicy } from '../../src/shared/utils/implement-commit-policy';
import type { PlanArtifact } from '../../src/agents/interfaces';
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
  console.log('Manual smoke: plan-step verification skips when commit policy allows commits\n');

  const policy = resolveCommitPolicy('low');
  if (policy.allowsCommit === true) {
    pass("resolveCommitPolicy('low').allowsCommit === true");
  } else {
    fail("Expected resolveCommitPolicy('low').allowsCommit === true", JSON.stringify(policy));
  }

  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error'] });
  const implementer = app.get(ImplementerAgent);
  const planStepVerification = app.get(PlanStepVerificationService);

  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'step-verify-skip-'));
  git(repoDir, ['init', '-q', '-b', 'master']);
  git(repoDir, ['config', 'user.email', 'test@example.com']);
  git(repoDir, ['config', 'user.name', 'Test']);
  fs.mkdirSync(path.join(repoDir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(repoDir, 'src', 'index.ts'), 'export const v = 1;\n');
  git(repoDir, ['add', '.']);
  git(repoDir, ['commit', '-q', '-m', 'baseline']);

  // simulate the implement stage's uncommitted output
  fs.writeFileSync(path.join(repoDir, 'src', 'index.ts'), 'export const v = 2;\n');

  const runCalls: unknown[] = [];
  const originalRun = planStepVerification.run.bind(planStepVerification);
  (planStepVerification as any).run = async (params: unknown) => {
    runCalls.push(params);
    return originalRun(params as any);
  };

  const scopedPlan: PlanArtifact = {
    action: 'feature',
    path: path.join(repoDir, 'plan.json'),
    plan: {
      action: 'feature',
      summary: 'Low complexity smoke test',
      steps: ['Update src/index.ts'],
      estimatedComplexity: 'low',
      affectedFiles: [],
      affectedRepositories: ['repo'],
      risks: [],
    },
  };
  const result = {
    type: 'implementation' as const,
    hasChanges: true,
    branchName: 'feature/smoke',
    sessionId: 'sess-1',
    verificationOutcomes: [],
  };

  const logPathBefore = todaysLogPath();
  const logSizeBefore = fs.existsSync(logPathBefore) ? fs.statSync(logPathBefore).size : 0;

  const finalResult = await (implementer as any).runPlanStepVerification(
    { ticketKey: 'WBP-1', content: '', path: '' },
    scopedPlan,
    { trackerName: 'jira', repoDir, silent: true },
    { repoName: 'repo', repoDir, repoFiles: [], contextFiles: [] },
    scopedPlan.plan.steps,
    result,
    null,
  );

  if (runCalls.length === 0) {
    pass('PlanStepVerificationService.run was never invoked');
  } else {
    fail('Expected PlanStepVerificationService.run to be skipped', `called ${runCalls.length} time(s)`);
  }

  if ((finalResult).stepVerification === undefined) {
    pass('Returned result has no stepVerification summary attached');
  } else {
    fail('Expected no stepVerification field', JSON.stringify((finalResult).stepVerification));
  }

  const logContentAfter = fs.existsSync(logPathBefore)
    ? fs.readFileSync(logPathBefore, 'utf-8').slice(logSizeBefore)
    : '';
  if (!logContentAfter.includes('step-verify.')) {
    pass('No step-verify.* lines written to the log file for this run');
  } else {
    fail('Expected no step-verify.* log lines', logContentAfter.slice(0, 300));
  }

  (planStepVerification as any).run = originalRun;
  fs.rmSync(repoDir, { recursive: true, force: true });

  console.log(`\n${passed} passed, ${failed} failed`);
  await app.close();
  if (failed > 0) process.exit(1);
  console.log('\nManual smoke test passed: plan-step verification commit-policy skip');
}

main().catch(error => {
  console.error(`\nManual smoke test failed: ${error.message}`);
  process.exit(1);
});
