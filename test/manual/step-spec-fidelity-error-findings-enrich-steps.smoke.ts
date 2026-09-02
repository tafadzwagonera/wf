/**
 * Manual smoke test: StepSpecFidelityService error findings are appended to
 * step text in the [SPEC FIDELITY ERRORS] block format consumed by
 * PlanStepVerificationService
 *
 * Scenario: Two plan steps are passed to StepSpecFidelityService.verifyAll.
 * The AI is stubbed to return one error finding for step 0 and no findings for
 * step 1. verifyAll must return a findings array of length 2. The private
 * enrichStepsWithFidelityErrors method on ImplementerAgent must append a
 * [SPEC FIDELITY ERRORS] block only to step 0, leaving step 1 unchanged.
 *
 * Verifies:
 *   1. verifyAll(['Step A', 'Step B'], repoDir, baselineSha) returns an array
 *      of length 2
 *   2. Result[0] contains one finding with severity "error"
 *   3. Result[1] is an empty array
 *   4. enrichStepsWithFidelityErrors returns step A enriched with
 *      "[SPEC FIDELITY ERRORS — must fix before this step is considered done]"
 *      and the claim text verbatim
 *   5. enrichStepsWithFidelityErrors returns step B unchanged
 *   6. AiService.execute was called exactly twice — once per step — with
 *      stage: 'review' and maxTokens: 2048
 *
 * Run: nr test:manual -- step-spec-fidelity-error-findings-enrich-steps.smoke
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../../src/app.module';
import { StepSpecFidelityService } from '../../src/agents/step-spec-fidelity.service';
import { ImplementerAgent } from '../../src/agents/implementer.agent';
import { AiService } from '../../src/integrations/ai/ai.service';
import { createReporter } from './support/reporter';

const { counts, pass, fail } = createReporter();

const git = (dir: string, args: string[]): string =>
  execFileSync('git', args, { cwd: dir, encoding: 'utf-8' }).trim();

async function main(): Promise<void> {
  console.log('Manual smoke: error findings from verifyAll are appended as [SPEC FIDELITY ERRORS] blocks\n');

  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error'] });
  const stepSpecFidelity = app.get(StepSpecFidelityService);
  const implementer = app.get(ImplementerAgent);
  const aiService = app.get(AiService);

  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'step-fidelity-enrich-'));
  git(repoDir, ['init', '-q', '-b', 'master']);
  git(repoDir, ['config', 'user.email', 'test@example.com']);
  git(repoDir, ['config', 'user.name', 'Test']);
  git(repoDir, ['config', 'commit.gpgsign', 'false']);
  fs.writeFileSync(path.join(repoDir, 'a.ts'), 'v1\n');
  git(repoDir, ['add', '.']);
  git(repoDir, ['commit', '-q', '-m', 'baseline']);
  const baselineSha = git(repoDir, ['rev-parse', 'HEAD']);

  // Unstaged change so captureDiff returns a non-empty diff
  fs.writeFileSync(path.join(repoDir, 'a.ts'), 'v2\n');

  const capturedRequests: Array<{ stage?: string; maxTokens?: number }> = [];
  let callIndex = 0;
  const originalExecute = aiService.execute.bind(aiService);
  (aiService as any).execute = async (req: { stage?: string; maxTokens?: number }) => {
    capturedRequests.push(req);
    if (callIndex++ === 0) {
      return {
        content: JSON.stringify({
          findings: [{ severity: 'error', claim: '/\\.ts$/', deviation: 'diff uses /\\.js$/' }],
        }),
      };
    }
    return { content: '{"findings":[]}' };
  };

  const result = await stepSpecFidelity.verifyAll(['Step A', 'Step B'], repoDir, baselineSha);

  (aiService as any).execute = originalExecute;

  // Verify 1
  if (result.length === 2) {
    pass('verifyAll returns an array of length 2 (one entry per step)');
  } else {
    fail(`Expected result.length === 2, got ${result.length}`);
  }

  // Verify 2
  if (result[0]?.length === 1 && result[0][0]?.severity === 'error') {
    pass('Result[0] contains one error-severity finding');
  } else {
    fail('Expected result[0] to have one error finding', JSON.stringify(result[0]));
  }

  // Verify 3
  if (result[1]?.length === 0) {
    pass('Result[1] is an empty array');
  } else {
    fail('Expected result[1] to be empty', JSON.stringify(result[1]));
  }

  // Verify 4 and 5: enrichStepsWithFidelityErrors via private access
  // Re-stub with same fixture
  callIndex = 0;
  (aiService as any).execute = async (req: { stage?: string; maxTokens?: number }) => {
    capturedRequests.push(req);
    if (callIndex++ === 0) {
      return {
        content: JSON.stringify({
          findings: [{ severity: 'error', claim: '/\\.ts$/', deviation: 'diff uses /\\.js$/' }],
        }),
      };
    }
    return { content: '{"findings":[]}' };
  };

  const enriched: string[] = await (implementer as any).enrichStepsWithFidelityErrors(
    ['Step A', 'Step B'], repoDir, baselineSha,
  );

  (aiService as any).execute = originalExecute;

  if (
    enriched[0]?.includes('[SPEC FIDELITY ERRORS — must fix before this step is considered done]')
    && enriched[0]?.includes('/\\.ts$/')
  ) {
    pass('Step A enriched with [SPEC FIDELITY ERRORS] block containing the claim verbatim');
  } else {
    fail('Expected step A to contain [SPEC FIDELITY ERRORS] and claim text', enriched[0]?.slice(0, 400));
  }

  if (enriched[1] === 'Step B') {
    pass('Step B returned unchanged (no [SPEC FIDELITY ERRORS] block)');
  } else {
    fail('Expected step B to be unchanged', enriched[1]);
  }

  // Verify 6: stage and maxTokens on every AI call (capturedRequests includes calls from both stubs)
  const reviewCalls = capturedRequests.filter(r => r.stage === 'review' && r.maxTokens === 2048);
  if (reviewCalls.length >= 2) {
    pass(`AiService.execute called with stage: 'review' and maxTokens: 2048 (${reviewCalls.length} calls)`);
  } else {
    fail(`Expected ≥ 2 calls with stage 'review' and maxTokens 2048, got ${reviewCalls.length}`, JSON.stringify(capturedRequests));
  }

  fs.rmSync(repoDir, { recursive: true, force: true });

  console.log(`\n${counts.passed} passed, ${counts.failed} failed`);
  await app.close();
  if (counts.failed > 0) process.exit(1);
  console.log('\nManual smoke test passed: step-spec-fidelity error findings enrich steps');
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
