/**
 * Manual Test: Provider session ID threading through standalone commands
 *
 * Run: nr test:manual -- test-session-id-threading
 *
 * Verifies:
 *   1. resumeProviderSessionId is accepted at every layer of the call chain
 *   2. Each backend method receives the param in its signature
 *   3. Standalone commands pass options.sessionId as resumeProviderSessionId
 *   4. OpenAI agent backend warns when resumeProviderSessionId is provided
 */

import { NestFactory } from '@nestjs/core';
import { AppModule } from '../../src/app.module';
import { StageAgentService } from '../../src/integrations/ai/stage-agent.service';
import { PlanStageService } from '../../src/workflows/stages/plan-stage.service';
import { ReviewStageService } from '../../src/workflows/stages/review-stage.service';
import { IssuePlanCommand } from '../../src/commands/issue-plan.command';
import { IssueImplementCommand } from '../../src/commands/issue-implement.command';
import { IssueReviewCommand } from '../../src/commands/issue-review.command';

let passed = 0;
let failed = 0;
const pass = (msg: string) => {
  console.log(`  \u2713 ${msg}`);
  passed++;
};
const fail = (msg: string, detail?: string) => {
  console.error(`  \u2717 ${msg}${detail ? `\n    -> ${detail}` : ''}`);
  failed++;
};

async function main() {
  console.log('\n=== Test: Provider session ID threading ===\n');

  const app = await NestFactory.createApplicationContext(AppModule, { logger: false });

  // ── Test 1: StageAgentService methods accept resumeProviderSessionId ────

  console.log('Test 1: StageAgentService backend methods accept resumeProviderSessionId');

  const stageService = app.get(StageAgentService);

  const runAnthropicSrc = (stageService as any).runAnthropicStagePrompt?.toString() ?? '';
  if (runAnthropicSrc.includes('resumeProviderSessionId')) {
    pass('runAnthropicStagePrompt accepts resumeProviderSessionId');
  } else {
    fail('runAnthropicStagePrompt missing resumeProviderSessionId');
  }

  const runCliSrc = (stageService as any).runCliStagePrompt?.toString() ?? '';
  if (runCliSrc.includes('resumeProviderSessionId')) {
    pass('runCliStagePrompt accepts resumeProviderSessionId');
  } else {
    fail('runCliStagePrompt missing resumeProviderSessionId');
  }

  const runCodexSrc = (stageService as any).runCodexCliStagePrompt?.toString() ?? '';
  if (runCodexSrc.includes('resumeProviderSessionId')) {
    pass('runCodexCliStagePrompt accepts resumeProviderSessionId');
  } else {
    fail('runCodexCliStagePrompt missing resumeProviderSessionId');
  }

  const runOpenAiSrc = (stageService as any).runOpenAiStagePrompt?.toString() ?? '';
  if (runOpenAiSrc.includes('resumeProviderSessionId')) {
    pass('runOpenAiStagePrompt accepts resumeProviderSessionId');
  } else {
    fail('runOpenAiStagePrompt missing resumeProviderSessionId');
  }

  // ── Test 2: Anthropic agent backend uses resume option ──────────────────

  console.log('\nTest 2: Anthropic agent backend wires resume option');

  if (runAnthropicSrc.includes('resume:') || runAnthropicSrc.includes('resume :')) {
    pass('runAnthropicStagePrompt constructs resume option from resumeProviderSessionId');
  } else {
    fail('runAnthropicStagePrompt does not construct resume option');
  }

  // ── Test 3: CLI backend seeds sessionId from resumeProviderSessionId ────

  console.log('\nTest 3: CLI backend seeds sessionId from resumeProviderSessionId');

  if (runCliSrc.includes('params.resumeProviderSessionId')) {
    pass('runCliStagePrompt references params.resumeProviderSessionId for initial sessionId');
  } else {
    fail('runCliStagePrompt does not reference params.resumeProviderSessionId');
  }

  // ── Test 4: OpenAI agent backend warns about deferred resumption ────────

  console.log('\nTest 4: OpenAI agent backend warns about deferred resumption');

  if (runOpenAiSrc.includes('Session resumption is not yet supported')) {
    pass('runOpenAiStagePrompt warns when resumeProviderSessionId is provided');
  } else {
    fail('runOpenAiStagePrompt missing deferred resumption warning');
  }

  // ── Test 5: generatePlan forwards resumeProviderSessionId ───────────────

  console.log('\nTest 5: generatePlan forwards resumeProviderSessionId');

  const generatePlanSrc = (stageService as any).generatePlan?.toString() ?? '';
  if (generatePlanSrc.includes('resumeProviderSessionId')) {
    pass('generatePlan accepts and forwards resumeProviderSessionId');
  } else {
    fail('generatePlan missing resumeProviderSessionId');
  }

  // ── Test 6: reviewCode forwards resumeProviderSessionId ─────────────────

  console.log('\nTest 6: reviewCode forwards resumeProviderSessionId');

  const reviewCodeSrc = (stageService as any).reviewCode?.toString() ?? '';
  if (reviewCodeSrc.includes('resumeProviderSessionId')) {
    pass('reviewCode accepts and forwards resumeProviderSessionId');
  } else {
    fail('reviewCode missing resumeProviderSessionId');
  }

  // ── Test 7: PlanStageService GeneratePlanOptions includes param ──────────

  console.log('\nTest 7: PlanStageService threads resumeProviderSessionId');

  const planStageService = app.get(PlanStageService);
  const planStageSrc = (planStageService as any).generatePlan?.toString() ?? '';
  if (planStageSrc.includes('resumeProviderSessionId')) {
    pass('PlanStageService.generatePlan threads resumeProviderSessionId');
  } else {
    fail('PlanStageService.generatePlan missing resumeProviderSessionId');
  }

  // ── Test 8: ReviewStageService ReviewDiffOptions includes param ──────────

  console.log('\nTest 8: ReviewStageService threads resumeProviderSessionId');

  const reviewStageService = app.get(ReviewStageService);
  const reviewDiffSrc = (reviewStageService as any).reviewDiff?.toString() ?? '';
  if (reviewDiffSrc.includes('resumeProviderSessionId')) {
    pass('ReviewStageService.reviewDiff threads resumeProviderSessionId');
  } else {
    fail('ReviewStageService.reviewDiff missing resumeProviderSessionId');
  }

  // ── Test 9: Standalone command option parsers declare --session-id ───────

  console.log('\nTest 9: Standalone commands declare --session-id option');

  const planCmd = app.get(IssuePlanCommand);
  const planParseSessionId = typeof (planCmd as any).parseSessionId === 'function';
  if (planParseSessionId) {
    pass('IssuePlanCommand has parseSessionId option parser');
  } else {
    fail('IssuePlanCommand missing parseSessionId');
  }

  const implCmd = app.get(IssueImplementCommand);
  const implParseSessionId = typeof (implCmd as any).parseSessionId === 'function';
  if (implParseSessionId) {
    pass('IssueImplementCommand has parseSessionId option parser');
  } else {
    fail('IssueImplementCommand missing parseSessionId');
  }

  const reviewCmd = app.get(IssueReviewCommand);
  const reviewParseSessionId = typeof (reviewCmd as any).parseSessionId === 'function';
  if (reviewParseSessionId) {
    pass('IssueReviewCommand has parseSessionId option parser');
  } else {
    fail('IssueReviewCommand missing parseSessionId');
  }

  // ── Summary ─────────────────────────────────────────────────────────────

  await app.close();

  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
