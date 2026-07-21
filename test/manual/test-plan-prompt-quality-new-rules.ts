/**
 * Manual smoke test: New plan prompt quality rules and testInfra convention assertions
 *
 * Run: nr test:manual -- test-plan-prompt-quality-new-rules
 *
 * Verifies that both AiService.generatePlan and StageAgentService.generatePlan
 * include the four new prompt-quality guardrail rules (unconditional) and that
 * testInfra convention lines for mockCleanup, diSetupPattern, and errorHandlerExits
 * appear when their respective fields are populated.
 */

import * as assert from 'node:assert/strict';
import { ConfigService } from '@nestjs/config';
import { AiService } from '../../src/integrations/ai/ai.service';
import { StageAgentService } from '../../src/integrations/ai/stage-agent.service';
import type { LlmAdapter } from '../../src/integrations/ai/llm-adapter.interface';
import type { LoggerService } from '../../src/shared/logger/logger.service';
import type { TestInfraContext } from '../../src/shared/utils/detect-test-infra';

const pass = (label: string) => console.log(`  \u2713 ${label}`);

// ---------------------------------------------------------------------------
// Substring constants — four new unconditional rules
// ---------------------------------------------------------------------------

const CLI_OPTION_DRIFT = 'help/doc text drift';
const CLEAN_STATE_HANDOFF = 'verification of both working-tree and staged/index state';
const SMOKE_TEST_COMPLETION = 'explicitly mark it as incomplete with a reason';
const ERROR_SWALLOWING_COVERAGE = 'Silent error swallowing without coverage is a latent bug';

// Substring constants — testInfra convention lines (conditional)
const MOCK_CLEANUP_DISCRIMINATING = 'Mock isolation: always prescribe';
const DI_SETUP_TESTING_MODULE = 'testing-module';
const ERROR_HANDLER_EXITS = 'process.exit';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const mockPlanResponse = JSON.stringify({
  action: 'fix',
  summary: 'Fix it',
  steps: ['step 1'],
  estimatedComplexity: 'low',
  affectedFiles: [],
  risks: [],
});

type SpyFn = ((...args: any[]) => any) & { calls: any[][] };

const createSpy = (returnValue: any): SpyFn => {
  const calls: any[][] = [];
  const fn = ((...args: any[]) => {
    calls.push(args);
    return returnValue;
  }) as SpyFn;
  fn.calls = calls;
  return fn;
};

const createMockLogger = (): LoggerService =>
  ({
    debug: () => {},
    error: () => {},
    warn: () => {},
    log: () => {},
  }) as unknown as LoggerService;

const createMockAdapter = () => ({
  execute: createSpy(Promise.resolve({ content: mockPlanResponse })),
  executeWithHistory: createSpy(Promise.resolve({ content: 'ok' })),
});

const createConfigService = (): ConfigService =>
  ({
    get: (key: string, defaultValue?: unknown) => {
      const values: Record<string, unknown> = {
        'ai.provider': 'openai',
        'ai.model': 'gpt-5.4',
        'ai.providers': [{ provider: 'openai', apiKey: 'k', model: 'gpt-5.4', default: true }],
        'stages.plan.backend': 'agent',
        'stages.plan.provider': 'openai',
        'stages.plan.model': 'gpt-5.4',
      };
      return key in values ? values[key] : defaultValue;
    },
  }) as unknown as ConfigService;

const mockTestInfraWithConventions: TestInfraContext = {
  primary: 'node',
  ecosystems: [
    {
      ecosystem: 'node' as const,
      frameworks: ['jest'],
      nodeVersionMajor: 22,
      hasNodeTest: true,
      scripts: { test: 'jest' },
      allScriptNames: ['test'],
      testPatterns: {
        fileSuffix: '.spec',
        mockPrefix: 'mock',
        mockFactoryPrefix: 'createMock',
        describeStyle: 'flat',
        helperPaths: ['src/test/helpers.ts'],
        mockCleanup: { namespace: 'jest', method: 'restoreAllMocks' },
        diSetupPattern: 'testing-module',
        errorHandlerExits: true,
      },
    },
  ],
};

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

(async () => {
  let assertions = 0;

  // Test 1: AiService — four new unconditional rules present
  {
    const adapter = createMockAdapter();
    const service = new AiService(createMockLogger(), adapter as unknown as LlmAdapter, createConfigService());

    await service.generatePlan('fix', '# WBP-NR1: Fix it');

    const prompt: string = adapter.execute.calls[0][0].prompt;

    assert.ok(prompt.includes(CLI_OPTION_DRIFT), 'AiService prompt must contain CLI option drift rule');
    pass('AiService: CLI option drift rule present');
    assertions += 1;

    assert.ok(prompt.includes(CLEAN_STATE_HANDOFF), 'AiService prompt must contain clean-state handoff rule');
    pass('AiService: clean-state handoff rule present');
    assertions += 1;

    assert.ok(prompt.includes(SMOKE_TEST_COMPLETION), 'AiService prompt must contain smoke test completion rule');
    pass('AiService: smoke test completion rule present');
    assertions += 1;

    assert.ok(
      prompt.includes(ERROR_SWALLOWING_COVERAGE),
      'AiService prompt must contain error swallowing coverage rule'
    );
    pass('AiService: error swallowing coverage rule present');
    assertions += 1;
  }

  // Test 2: StageAgentService — four new unconditional rules present
  {
    const service = new StageAgentService(createConfigService());
    const mockRunStagePrompt = createSpy(Promise.resolve({ content: mockPlanResponse }));
    (service as unknown as { runStagePrompt: typeof mockRunStagePrompt }).runStagePrompt = mockRunStagePrompt;

    await service.generatePlan({ action: 'fix', issueContent: '# WBP-NR2: Fix it' });

    const prompt: string = mockRunStagePrompt.calls[0][0].prompt;

    assert.ok(prompt.includes(CLI_OPTION_DRIFT), 'StageAgentService prompt must contain CLI option drift rule');
    pass('StageAgentService: CLI option drift rule present');
    assertions += 1;

    assert.ok(prompt.includes(CLEAN_STATE_HANDOFF), 'StageAgentService prompt must contain clean-state handoff rule');
    pass('StageAgentService: clean-state handoff rule present');
    assertions += 1;

    assert.ok(
      prompt.includes(SMOKE_TEST_COMPLETION),
      'StageAgentService prompt must contain smoke test completion rule'
    );
    pass('StageAgentService: smoke test completion rule present');
    assertions += 1;

    assert.ok(
      prompt.includes(ERROR_SWALLOWING_COVERAGE),
      'StageAgentService prompt must contain error swallowing coverage rule'
    );
    pass('StageAgentService: error swallowing coverage rule present');
    assertions += 1;
  }

  // Test 3: StageAgentService — testInfra convention lines appear with populated fields
  {
    const service = new StageAgentService(createConfigService());
    const mockRunStagePrompt = createSpy(Promise.resolve({ content: mockPlanResponse }));
    (service as unknown as { runStagePrompt: typeof mockRunStagePrompt }).runStagePrompt = mockRunStagePrompt;

    await service.generatePlan({
      action: 'fix',
      issueContent: '# WBP-NR3: Fix it',
      testInfra: mockTestInfraWithConventions,
    });

    const prompt: string = mockRunStagePrompt.calls[0][0].prompt;

    assert.ok(
      prompt.includes(MOCK_CLEANUP_DISCRIMINATING),
      'StageAgentService prompt must contain discriminating mockCleanup convention line'
    );
    pass('StageAgentService: mockCleanup convention line present (discriminating substring)');
    assertions += 1;

    assert.ok(
      prompt.includes(DI_SETUP_TESTING_MODULE),
      'StageAgentService prompt must contain testing-module DI setup convention line'
    );
    pass('StageAgentService: diSetupPattern convention line present');
    assertions += 1;

    assert.ok(
      prompt.includes(ERROR_HANDLER_EXITS),
      'StageAgentService prompt must contain process.exit error handler convention line'
    );
    pass('StageAgentService: errorHandlerExits convention line present');
    assertions += 1;
  }

  // Test 4: StageAgentService — mockCleanup convention absent without testInfra
  {
    const service = new StageAgentService(createConfigService());
    const mockRunStagePrompt = createSpy(Promise.resolve({ content: mockPlanResponse }));
    (service as unknown as { runStagePrompt: typeof mockRunStagePrompt }).runStagePrompt = mockRunStagePrompt;

    await service.generatePlan({ action: 'fix', issueContent: '# WBP-NR4: Fix it' });

    const prompt: string = mockRunStagePrompt.calls[0][0].prompt;

    assert.ok(
      !prompt.includes(MOCK_CLEANUP_DISCRIMINATING),
      'StageAgentService prompt must NOT contain mockCleanup convention without testInfra'
    );
    pass('StageAgentService: mockCleanup convention absent without testInfra');
    assertions += 1;
  }

  // Test 5: AiService — testInfra convention lines appear with populated fields
  {
    const adapter = createMockAdapter();
    const service = new AiService(createMockLogger(), adapter as unknown as LlmAdapter, createConfigService());

    await service.generatePlan('fix', '# WBP-NR5: Fix it', { testInfra: mockTestInfraWithConventions });

    const prompt: string = adapter.execute.calls[0][0].prompt;

    assert.ok(
      prompt.includes(MOCK_CLEANUP_DISCRIMINATING),
      'AiService prompt must contain discriminating mockCleanup convention line'
    );
    pass('AiService: mockCleanup convention line present (discriminating substring)');
    assertions += 1;

    assert.ok(
      prompt.includes(DI_SETUP_TESTING_MODULE),
      'AiService prompt must contain testing-module DI setup convention line'
    );
    pass('AiService: diSetupPattern convention line present');
    assertions += 1;

    assert.ok(
      prompt.includes(ERROR_HANDLER_EXITS),
      'AiService prompt must contain process.exit error handler convention line'
    );
    pass('AiService: errorHandlerExits convention line present');
    assertions += 1;
  }

  console.log(`\n  ${assertions}/${assertions} assertions passed`);
})();
