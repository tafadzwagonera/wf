/**
 * Manual smoke test: plan-step verification skips entirely when commit
 * policy allows commits (low-complexity / stage-and-commit-per-change)
 *
 * Verifies:
 *   1. runPlanStepVerification returns the result unchanged — no stepVerification
 *      summary is attached — for a low-complexity plan
 *
 * Checks covered elsewhere:
 *   - resolveCommitPolicy('low').allowsCommit === true: Jest unit spec
 *   - planStepVerification.run is not called: plan-step-verification-skip-reason-log.smoke
 *   - log emits step-verify.skipped reason=commit-policy-allows-direct-commit:
 *     plan-step-verification-skip-reason-log.smoke
 *
 * Run: nr test:manual -- plan-step-verification-commit-policy-skip
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../../src/app.module';
import { ImplementerAgent } from '../../src/agents/implementer.agent';
import type { PlanArtifact } from '../../src/agents/interfaces';
import { createReporter } from './support/reporter';

const { counts, pass, fail } = createReporter();

const git = (dir: string, args: string[]): void => {
  execFileSync('git', args, { cwd: dir, encoding: 'utf-8' });
};

async function main(): Promise<void> {
  console.log('Manual smoke: plan-step verification skips when commit policy allows commits\n');

  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error'] });
  const implementer = app.get(ImplementerAgent);

  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'step-verify-skip-'));
  git(repoDir, ['init', '-q', '-b', 'master']);
  git(repoDir, ['config', 'user.email', 'test@example.com']);
  git(repoDir, ['config', 'user.name', 'Test']);
  fs.mkdirSync(path.join(repoDir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(repoDir, 'src', 'index.ts'), 'export const v = 1;\n');
  git(repoDir, ['add', '.']);
  git(repoDir, ['commit', '-q', '-m', 'baseline']);
  fs.writeFileSync(path.join(repoDir, 'src', 'index.ts'), 'export const v = 2;\n');

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

  const finalResult = await (implementer as any).runPlanStepVerification(
    { ticketKey: 'WBP-1', content: '', path: '' },
    scopedPlan,
    { trackerName: 'jira', repoDir, silent: true },
    { repoName: 'repo', repoDir, repoFiles: [], contextFiles: [] },
    scopedPlan.plan.steps,
    result,
    null,
  );

  if ((finalResult).stepVerification === undefined) {
    pass('Returned result has no stepVerification summary attached');
  } else {
    fail('Expected no stepVerification field', JSON.stringify((finalResult).stepVerification));
  }

  fs.rmSync(repoDir, { recursive: true, force: true });

  console.log(`\n${counts.passed} passed, ${counts.failed} failed`);
  await app.close();
  if (counts.failed > 0) process.exit(1);
  console.log('\nManual smoke test passed: plan-step verification commit-policy skip');
}

main().catch(error => {
  console.error(`\nManual smoke test failed: ${error.message}`);
  process.exit(1);
});
