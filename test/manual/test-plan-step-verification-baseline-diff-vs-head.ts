/**
 * Manual smoke test: plan-step verification diffs against the frozen
 * pre-implement baseline commit, not a moving HEAD
 *
 * Scenario: the implement stage commits despite a blocked commit policy, and
 * enforceCommitPolicy's soft-reset is skipped because a merge commit is
 * detected in the range (one of resolveRewindSkipReason's safety exits). The
 * disallowed commit is left in place — HEAD now sits past the original
 * baseline. Plan-step verification must still see the full changeset by
 * diffing against the captured baseline, not literal 'HEAD' (which would show
 * an empty diff since everything is committed).
 *
 * Verifies:
 *   1. resolveCommitPolicy('high').allowsCommit === false
 *   2. enforceCommitPolicy detects the merge commit and skips the rewind —
 *      HEAD is NOT reset back to the baseline
 *   3. buildVerificationRunParams's baseRef equals the pre-implement baseline
 *      SHA (not 'HEAD', not the post-merge commit SHA)
 *   4. git diff <baseRef> (via PlanStepVerificationService.getDiff) includes
 *      the file changed in the unrewound merge commit
 *   5. git diff HEAD (the OLD behavior) on the same repo state returns empty —
 *      proving the fix is load-bearing, not cosmetic
 *
 * Run: nr test:manual -- test-plan-step-verification-baseline-diff-vs-head
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

async function main(): Promise<void> {
  console.log('Manual smoke: plan-step verification diffs against frozen baseline, not moving HEAD\n');

  const policy = resolveCommitPolicy('high');
  if (policy.allowsCommit === false) {
    pass("resolveCommitPolicy('high').allowsCommit === false");
  } else {
    fail("Expected resolveCommitPolicy('high').allowsCommit === false", JSON.stringify(policy));
  }

  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error'] });
  const implementer = app.get(ImplementerAgent);
  const planStepVerification = app.get(PlanStepVerificationService);

  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'step-verify-baseline-'));
  git(repoDir, ['init', '-q', '-b', 'master']);
  git(repoDir, ['config', 'user.email', 'test@example.com']);
  git(repoDir, ['config', 'user.name', 'Test']);
  git(repoDir, ['config', 'commit.gpgsign', 'false']);
  fs.writeFileSync(path.join(repoDir, 'a.ts'), 'v1\n');
  git(repoDir, ['add', '.']);
  git(repoDir, ['commit', '-q', '-m', 'baseline']);

  const baseline = await (implementer as any).captureCommitBaseline(repoDir);
  if (baseline?.sha) {
    pass(`Baseline captured: ${baseline.sha.slice(0, 8)}`);
  } else {
    fail('Expected a captured baseline commit', JSON.stringify(baseline));
  }

  // Simulate the agent's disallowed self-commit landing as a merge commit.
  git(repoDir, ['checkout', '-q', '-b', 'agent-work']);
  fs.writeFileSync(path.join(repoDir, 'b.ts'), 'agent change\n');
  git(repoDir, ['add', '.']);
  git(repoDir, ['commit', '-q', '-m', 'agent: implement feature']);
  git(repoDir, ['checkout', '-q', 'master']);
  git(repoDir, ['merge', '--no-ff', '-q', '-m', 'merge agent work', 'agent-work']);

  const headBeforeEnforce = git(repoDir, ['rev-parse', 'HEAD']);

  await (implementer as any).enforceCommitPolicy(policy, baseline, repoDir);

  const headAfterEnforce = git(repoDir, ['rev-parse', 'HEAD']);
  if (headAfterEnforce === headBeforeEnforce && headAfterEnforce !== baseline.sha) {
    pass('enforceCommitPolicy skipped the rewind (merge commit detected) — HEAD left past baseline');
  } else {
    fail('Expected HEAD to be left unchanged past baseline', `before=${headBeforeEnforce} after=${headAfterEnforce} baseline=${baseline.sha}`);
  }

  const params = (implementer as any).buildVerificationRunParams({
    ticket: { ticketKey: 'WBP-1', content: '', path: '' },
    scopedPlan: { action: 'feature', path: path.join(repoDir, 'plan.json'), plan: { action: 'feature', summary: 's', steps: ['x'], estimatedComplexity: 'high', affectedFiles: [], affectedRepositories: [], risks: [] } },
    options: { trackerName: 'jira', repoDir, silent: true },
    resolved: { repoName: 'repo', repoDir, repoFiles: [], contextFiles: [] },
    assessedSteps: ['x'],
    sessionId: 'sess-1',
    maxRounds: 3,
    baseline,
  });

  if (params.baseRef === baseline.sha) {
    pass('PlanStepVerificationRunParams.baseRef equals the pre-implement baseline SHA');
  } else {
    fail('Expected baseRef to equal the captured baseline SHA', `baseRef=${params.baseRef} baseline=${baseline.sha}`);
  }

  const diffAgainstBaseline: string = await (planStepVerification as any).getDiff(repoDir, params.baseRef);
  if (diffAgainstBaseline.includes('b.ts')) {
    pass('git diff <baseRef> includes the file changed in the unrewound merge commit');
  } else {
    fail('Expected diff against baseRef to include b.ts', diffAgainstBaseline.slice(0, 300));
  }

  const diffAgainstHead: string = await (planStepVerification as any).getDiff(repoDir, 'HEAD');
  if (diffAgainstHead.trim() === '') {
    pass('git diff HEAD (the OLD behavior) is empty — proving the fix is load-bearing, not cosmetic');
  } else {
    fail('Expected diff against literal HEAD to be empty', diffAgainstHead.slice(0, 300));
  }

  fs.rmSync(repoDir, { recursive: true, force: true });

  console.log(`\n${passed} passed, ${failed} failed`);
  await app.close();
  if (failed > 0) process.exit(1);
  console.log('\nManual smoke test passed: plan-step verification baseline diff vs HEAD');
}

main().catch(error => {
  console.error(`\nManual smoke test failed: ${error.message}`);
  process.exit(1);
});
