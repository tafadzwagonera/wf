/**
 * Manual Test: plan/findings/review truncation guard and maxTokens config
 *
 * Run: nr test:manual -- test-plan-truncation-guard
 *
 * Verifies that stages producing JSON (plan, findings, review) detect
 * truncated responses via stopReason/finishReason and throw actionable
 * AIError messages pointing at the relevant stages.<stage>.maxTokens
 * config key. Also verifies that maxTokens is forwarded to the adapter.
 */

import { NestFactory } from '@nestjs/core';
import { AppModule } from '../../src/app.module';
import { AiService } from '../../src/integrations/ai/ai.service';

async function testTruncationGuard() {
  console.log('\n--- Manual Test: plan/findings/review truncation guard ---\n');

  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn'],
  });

  let passed = 0;
  let failed = 0;

  const pass = (message: string) => {
    console.log(`  PASS ${message}`);
    passed++;
  };

  const fail = (message: string, detail?: string) => {
    console.error(`  FAIL ${message}${detail ? `\n    -> ${detail}` : ''}`);
    failed++;
  };

  const passWhen = (condition: boolean, successMessage: string, failureMessage: string, detail?: string) => {
    if (condition) {
      pass(successMessage);
      return;
    }

    fail(failureMessage, detail);
  };

  const aiService = app.get(AiService);
  const originalExecute = AiService.prototype.execute;

  try {
    // --- Test 1: generatePlan detects Anthropic-style truncation (stopReason: max_tokens) ---
    (AiService.prototype as any).execute = async () => ({
      content: '{"action":"fix","summary":"Truncated',
      stopReason: 'max_tokens',
      usage: { inputTokens: 500, outputTokens: 4096 },
    });

    try {
      await aiService.generatePlan('fix', '# TRUNC-1: plan truncation');
      fail('generatePlan should reject truncated output (stopReason)');
    } catch (error: any) {
      passWhen(
        error?.message?.includes('stages.plan.maxTokens'),
        'generatePlan throws actionable error on stopReason: max_tokens',
        'generatePlan threw wrong error on stopReason truncation',
        error?.message ?? String(error)
      );
    }

    // --- Test 2: generatePlan detects OpenAI-style truncation (finishReason: length) ---
    (AiService.prototype as any).execute = async () => ({
      content: '{"action":"fix","summary":"Truncated',
      finishReason: 'length',
      usage: { inputTokens: 500, outputTokens: 4096 },
    });

    try {
      await aiService.generatePlan('fix', '# TRUNC-2: plan finishReason truncation');
      fail('generatePlan should reject truncated output (finishReason)');
    } catch (error: any) {
      passWhen(
        error?.message?.includes('stages.plan.maxTokens'),
        'generatePlan throws actionable error on finishReason: length',
        'generatePlan threw wrong error on finishReason truncation',
        error?.message ?? String(error)
      );
    }

    // --- Test 3: generateFindings detects truncation ---
    (AiService.prototype as any).execute = async () => ({
      content: '{"action":"investigate","summary":"Truncated',
      stopReason: 'max_tokens',
      usage: { inputTokens: 500, outputTokens: 4096 },
    });

    try {
      await aiService.generateFindings(
        {
          action: 'investigate',
          summary: 'Test findings truncation',
          steps: ['Step 1'],
          estimatedComplexity: 'low',
          affectedFiles: [],
          affectedRepositories: [],
          risks: [],
        },
        '# TRUNC-3: findings truncation'
      );
      fail('generateFindings should reject truncated output');
    } catch (error: any) {
      passWhen(
        error?.message?.includes('stages.implement.maxTokens'),
        'generateFindings throws actionable error on truncation',
        'generateFindings threw wrong error on truncation',
        error?.message ?? String(error)
      );
    }

    // --- Test 4: reviewCode detects truncation ---
    (AiService.prototype as any).execute = async () => ({
      content: '{"summary":"Truncated review',
      stopReason: 'max_tokens',
      usage: { inputTokens: 500, outputTokens: 4096 },
    });

    try {
      await aiService.reviewCode('diff --git a/file.ts', ['guideline 1']);
      fail('reviewCode should reject truncated output');
    } catch (error: any) {
      passWhen(
        error?.message?.includes('stages.review.maxTokens'),
        'reviewCode throws actionable error on truncation',
        'reviewCode threw wrong error on truncation',
        error?.message ?? String(error)
      );
    }

    // --- Test 5: maxTokens is forwarded to the adapter for plan ---
    let capturedRequest: any = null;
    (AiService.prototype as any).execute = async (request: any) => {
      capturedRequest = request;
      return {
        content: JSON.stringify({
          action: 'fix',
          summary: 'ok',
          steps: ['step'],
          estimatedComplexity: 'low',
          affectedFiles: [],
          affectedRepositories: [],
          risks: [],
        }),
      };
    };

    await aiService.generatePlan('fix', '# TRUNC-5: maxTokens forwarding');
    passWhen(
      capturedRequest?.maxTokens === 16384,
      'generatePlan forwards default maxTokens (16384) to execute()',
      'generatePlan did not forward expected maxTokens to execute()',
      `got maxTokens: ${capturedRequest?.maxTokens}`
    );

    // --- Test 6: non-truncated response parses successfully via parseJsonResponse ---
    (AiService.prototype as any).execute = async () => ({
      content:
        'Here is the plan:\n```json\n' +
        JSON.stringify({
          action: 'fix',
          summary: 'Test parse',
          steps: ['step 1'],
          estimatedComplexity: 'low',
          affectedFiles: [],
          affectedRepositories: ['repo-a'],
          risks: [],
        }) +
        '\n```\nDone.',
    });

    try {
      const plan = await aiService.generatePlan('fix', '# TRUNC-6: wrapped JSON');
      passWhen(
        plan.summary === 'Test parse' && plan.affectedRepositories?.[0] === 'repo-a',
        'generatePlan parses JSON wrapped in code fences and preamble text',
        'generatePlan failed to parse wrapped JSON',
        `got summary: ${plan?.summary}`
      );
    } catch (error: any) {
      fail('generatePlan should parse wrapped JSON successfully', error?.message ?? String(error));
    }
  } finally {
    AiService.prototype.execute = originalExecute;
    await app.close();
  }

  console.log(`\nResults: ${passed} passed, ${failed} failed\n`);
  if (failed > 0) {
    process.exit(1);
  }

  process.exit(0);
}

void testTruncationGuard();
