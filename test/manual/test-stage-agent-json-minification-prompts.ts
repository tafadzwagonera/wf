/**
 * Manual smoke test: Stage-agent JSON minification prompts
 *
 * Run: nr test:manual -- test-stage-agent-json-minification-prompts
 *
 * Verifies that:
 * 1. The plan prompt keeps its example JSON valid and appends the minification
 *    instruction after the closing brace.
 * 2. The review prompt keeps its example JSON valid and appends the same
 *    instruction after the closing brace.
 * 3. The CLI resume/retry prompt preserves the raw, minified JSON wording.
 */

import assert from 'node:assert/strict';
import { ConfigService } from '@nestjs/config';
import { StageAgentService } from '../../src/integrations/ai/stage-agent.service';

let passed = 0;
let failed = 0;

const test = async (name: string, fn: () => void | Promise<void>): Promise<void> => {
  try {
    await fn();
    console.log(`  PASS  ${name}`);
    passed += 1;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.log(`  FAIL  ${name}: ${message}`);
    failed += 1;
  }
};

const createConfigService = (): ConfigService =>
  ({
    get: (key: string, defaultValue?: unknown) => {
      const values: Record<string, unknown> = {
        'stages.plan.backend': 'agent',
        'stages.plan.provider': 'openai',
        'stages.plan.model': 'gpt-5.4',
        'stages.review.backend': 'agent',
        'stages.review.provider': 'openai',
        'stages.review.model': 'gpt-5.4',
        'ai.provider': 'openai',
        'ai.model': 'gpt-5.4',
      };

      return key in values ? values[key] : defaultValue;
    },
  }) as unknown as ConfigService;

const mockPlanResponse = JSON.stringify({
  action: 'fix',
  summary: 'Fix it',
  steps: ['step 1'],
  estimatedComplexity: 'low',
  affectedFiles: [],
  risks: [],
});

const mockReviewResponse = JSON.stringify({
  summary: 'Looks good',
  issues: [],
  suggestions: [],
  approved: true,
});

const run = async (): Promise<void> => {
  console.log('\n--- Stage-agent JSON minification prompts ---');

  await test('plan prompt appends minification instruction after the example block', async () => {
    const service = new StageAgentService(createConfigService());
    let capturedPrompt = '';
    const mockRunStagePrompt = async (params: { prompt: string }) => {
      capturedPrompt = params.prompt;
      return { content: mockPlanResponse };
    };

    (service as unknown as { runStagePrompt: typeof mockRunStagePrompt }).runStagePrompt = mockRunStagePrompt;

    await service.generatePlan({
      action: 'fix',
      issueContent: 'Fix callback handling',
      affectedRepositories: ['repo-a'],
    });

    assert.ok(
      capturedPrompt.includes('  }\n}\n\nIMPORTANT: Minify the JSON — no unnecessary whitespace or newlines.'),
      'plan prompt should place the minification instruction after the example block'
    );
    assert.ok(
      !capturedPrompt.includes('  }\nIMPORTANT: Minify the JSON — no unnecessary whitespace or newlines.\n}'),
      'plan prompt should not place the minification instruction inside the JSON example'
    );
  });

  await test('review prompt appends minification instruction after the example block', async () => {
    const service = new StageAgentService(createConfigService());
    let capturedPrompt = '';
    const mockRunStagePrompt = async (params: { prompt: string }) => {
      capturedPrompt = params.prompt;
      return { content: mockReviewResponse };
    };

    (service as unknown as { runStagePrompt: typeof mockRunStagePrompt }).runStagePrompt = mockRunStagePrompt;

    await service.reviewCode('diff --git a/f b/f', []);

    assert.ok(
      capturedPrompt.includes(
        '  "approved": true\n}\n\nIMPORTANT: Minify the JSON — no unnecessary whitespace or newlines.'
      ),
      'review prompt should place the minification instruction after the example block'
    );
    assert.ok(
      !capturedPrompt.includes(
        '  "approved": true\nIMPORTANT: Minify the JSON — no unnecessary whitespace or newlines.\n}'
      ),
      'review prompt should not place the minification instruction inside the JSON example'
    );
  });

  await test('CLI retry prompt preserves the raw, minified JSON wording', async () => {
    const service = new StageAgentService({
      get: (key: string, defaultValue?: unknown) => {
        const values: Record<string, unknown> = {
          'stages.plan.backend': 'cli',
          'stages.plan.provider': 'anthropic',
          'stages.plan.model': 'claude-sonnet-4-5-20250514',
          'ai.provider': 'anthropic',
          'ai.model': 'claude-sonnet-4-5-20250514',
        };

        return key in values ? values[key] : defaultValue;
      },
    } as unknown as ConfigService);

    const source = (service as unknown as { runCliStagePrompt: () => void }).runCliStagePrompt.toString();

    assert.ok(
      source.includes('IMPORTANT: raw, minified JSON only (no unnecessary whitespace or newlines).'),
      'CLI retry prompt should require raw, minified JSON'
    );
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) {
    process.exit(1);
  }
};

void run();
