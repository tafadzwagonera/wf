/**
 * Manual smoke test: Plan prompt quality constraints
 *
 * Run: nr test:manual -- test-plan-prompt-quality-constraints
 *
 * Verifies that both AiService.generatePlan and StageAgentService.generatePlan
 * include the following prompt-quality constraints:
 *   1. Call-site tracing paragraph (unconditional)
 *   2. JSDoc cross-check paragraph (unconditional)
 *   3. DI wiring bullet (conditional on testInfra)
 *   4. Test isolation conventions bullet (conditional on testInfra)
 *   5. Old generic DI assumption bullet is absent
 *   6. Node-specific shell-safety guidance appears only when testInfra includes node
 *   7. Flag version cross-check paragraph (unconditional)
 *   8. Return type from call-site rule (unconditional)
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
// Helpers — no jest dependency; plain call-recording spies
// ---------------------------------------------------------------------------

const CALL_SITE_TRACING = 'plan MUST trace every existing call site';
const JSDOC_CROSS_CHECK = "cross-checked against the implementation's guard clauses";
const DI_WIRING = 'every injected service the code reaches MUST have a mock provider';
const TEST_ISOLATION = "Follow the repo's existing test isolation conventions";
const OLD_DI_BULLET = 'State your DI and test-framework assumptions explicitly';
const NODE_SHELL_SAFETY = 'Verification commands MUST be shell-safe by construction.';
const FLAG_VERSION_CHECK = 'cross-check flag names against the installed framework version';
const RETURN_TYPE_CALLSITE = 'plan MUST derive';
const SUBSTRING_VERIFICATION = 'perform an exact substring check';

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

const mockTestInfra: TestInfraContext = {
  primary: 'node',
  ecosystems: [
    {
      ecosystem: 'node' as const,
      frameworks: ['jest'],
      nodeVersionMajor: 22,
      hasNodeTest: true,
      scripts: { test: 'jest', build: 'nest build' },
      allScriptNames: ['test', 'build'],
    },
  ],
};

const mockTerraformInfra: TestInfraContext = {
  primary: 'terraform',
  ecosystems: [
    {
      ecosystem: 'terraform',
      hasTfFiles: true,
      hasBackendConfig: false,
    },
  ],
};

// ---------------------------------------------------------------------------
// Main — wrapped in async IIFE for CommonJS compatibility
// ---------------------------------------------------------------------------

(async () => {
  // Test 1: AiService — unconditional constraints present (no testInfra)
  {
    const adapter = createMockAdapter();
    const service = new AiService(createMockLogger(), adapter as unknown as LlmAdapter, createConfigService());

    await service.generatePlan('fix', '# WBP-1: Fix it');

    const prompt: string = adapter.execute.calls[0][0].prompt;

    assert.ok(prompt.includes(CALL_SITE_TRACING), 'AiService prompt must contain call-site tracing');
    pass('AiService: call-site tracing paragraph present');

    assert.ok(prompt.includes(JSDOC_CROSS_CHECK), 'AiService prompt must contain JSDoc cross-check');
    pass('AiService: JSDoc cross-check paragraph present');

    assert.ok(!prompt.includes(DI_WIRING), 'AiService prompt must NOT contain DI wiring bullet without testInfra');
    pass('AiService: DI wiring bullet absent without testInfra');

    assert.ok(!prompt.includes(OLD_DI_BULLET), 'AiService prompt must NOT contain old DI assumption bullet');
    pass('AiService: old DI assumption bullet absent');

    assert.ok(
      !prompt.includes(NODE_SHELL_SAFETY),
      'AiService prompt must NOT contain node shell-safety guidance without node testInfra'
    );
    pass('AiService: node shell-safety guidance absent without testInfra');

    assert.ok(prompt.includes(FLAG_VERSION_CHECK), 'AiService prompt must contain flag version cross-check');
    pass('AiService: flag version cross-check present');

    assert.ok(prompt.includes(RETURN_TYPE_CALLSITE), 'AiService prompt must contain return type from call-site rule');
    pass('AiService: return type from call-site rule present');

    assert.ok(prompt.includes(SUBSTRING_VERIFICATION), 'AiService prompt must contain substring verification rule');
    pass('AiService: substring verification rule present');
  }

  // Test 2: AiService — conditional constraints present (with testInfra)
  {
    const adapter = createMockAdapter();
    const service = new AiService(createMockLogger(), adapter as unknown as LlmAdapter, createConfigService());

    await service.generatePlan('fix', '# WBP-2: Fix it', { testInfra: mockTestInfra });

    const prompt: string = adapter.execute.calls[0][0].prompt;

    assert.ok(prompt.includes(DI_WIRING), 'AiService prompt must contain DI wiring bullet with testInfra');
    pass('AiService: DI wiring bullet present with testInfra');

    assert.ok(prompt.includes(TEST_ISOLATION), 'AiService prompt must contain test isolation bullet with testInfra');
    pass('AiService: test isolation conventions bullet present with testInfra');

    assert.ok(
      prompt.includes(NODE_SHELL_SAFETY),
      'AiService prompt must contain node shell-safety guidance with node testInfra'
    );
    pass('AiService: node shell-safety guidance present with node testInfra');
  }

  // Test 2b: AiService — node-only shell-safety guidance omitted for non-node infra
  {
    const adapter = createMockAdapter();
    const service = new AiService(createMockLogger(), adapter as unknown as LlmAdapter, createConfigService());

    await service.generatePlan('fix', '# WBP-2b: Fix terraform flow', { testInfra: mockTerraformInfra });

    const prompt: string = adapter.execute.calls[0][0].prompt;

    assert.ok(
      !prompt.includes(NODE_SHELL_SAFETY),
      'AiService prompt must NOT contain node shell-safety guidance with non-node testInfra'
    );
    pass('AiService: node shell-safety guidance absent with non-node testInfra');
  }

  // Test 3: StageAgentService — unconditional constraints present (no testInfra)
  {
    const service = new StageAgentService(createConfigService());
    const mockRunStagePrompt = createSpy(Promise.resolve({ content: mockPlanResponse }));
    (service as unknown as { runStagePrompt: typeof mockRunStagePrompt }).runStagePrompt = mockRunStagePrompt;

    await service.generatePlan({ action: 'fix', issueContent: '# WBP-3: Fix it' });

    const prompt: string = mockRunStagePrompt.calls[0][0].prompt;

    assert.ok(prompt.includes(CALL_SITE_TRACING), 'StageAgentService prompt must contain call-site tracing');
    pass('StageAgentService: call-site tracing paragraph present');

    assert.ok(prompt.includes(JSDOC_CROSS_CHECK), 'StageAgentService prompt must contain JSDoc cross-check');
    pass('StageAgentService: JSDoc cross-check paragraph present');

    assert.ok(!prompt.includes(DI_WIRING), 'StageAgentService prompt must NOT contain DI wiring without testInfra');
    pass('StageAgentService: DI wiring bullet absent without testInfra');

    assert.ok(!prompt.includes(OLD_DI_BULLET), 'StageAgentService prompt must NOT contain old DI assumption bullet');
    pass('StageAgentService: old DI assumption bullet absent');

    assert.ok(
      !prompt.includes(NODE_SHELL_SAFETY),
      'StageAgentService prompt must NOT contain node shell-safety guidance without testInfra'
    );
    pass('StageAgentService: node shell-safety guidance absent without testInfra');

    assert.ok(prompt.includes(FLAG_VERSION_CHECK), 'StageAgentService prompt must contain flag version cross-check');
    pass('StageAgentService: flag version cross-check present');

    assert.ok(
      prompt.includes(RETURN_TYPE_CALLSITE),
      'StageAgentService prompt must contain return type from call-site rule'
    );
    pass('StageAgentService: return type from call-site rule present');

    assert.ok(
      prompt.includes(SUBSTRING_VERIFICATION),
      'StageAgentService prompt must contain substring verification rule'
    );
    pass('StageAgentService: substring verification rule present');
  }

  // Test 4: StageAgentService — conditional constraints present (with testInfra)
  {
    const service = new StageAgentService(createConfigService());
    const mockRunStagePrompt = createSpy(Promise.resolve({ content: mockPlanResponse }));
    (service as unknown as { runStagePrompt: typeof mockRunStagePrompt }).runStagePrompt = mockRunStagePrompt;

    await service.generatePlan({
      action: 'fix',
      issueContent: '# WBP-4: Fix it',
      testInfra: mockTestInfra,
    });

    const prompt: string = mockRunStagePrompt.calls[0][0].prompt;

    assert.ok(prompt.includes(DI_WIRING), 'StageAgentService prompt must contain DI wiring with testInfra');
    pass('StageAgentService: DI wiring bullet present with testInfra');

    assert.ok(prompt.includes(TEST_ISOLATION), 'StageAgentService prompt must contain test isolation with testInfra');
    pass('StageAgentService: test isolation conventions bullet present with testInfra');

    assert.ok(
      prompt.includes(NODE_SHELL_SAFETY),
      'StageAgentService prompt must contain node shell-safety guidance with node testInfra'
    );
    pass('StageAgentService: node shell-safety guidance present with node testInfra');
  }

  // Test 4b: StageAgentService — node-only shell-safety guidance omitted for non-node infra
  {
    const service = new StageAgentService(createConfigService());
    const mockRunStagePrompt = createSpy(Promise.resolve({ content: mockPlanResponse }));
    (service as unknown as { runStagePrompt: typeof mockRunStagePrompt }).runStagePrompt = mockRunStagePrompt;

    await service.generatePlan({
      action: 'fix',
      issueContent: '# WBP-4b: Fix terraform flow',
      testInfra: mockTerraformInfra,
    });

    const prompt: string = mockRunStagePrompt.calls[0][0].prompt;

    assert.ok(
      !prompt.includes(NODE_SHELL_SAFETY),
      'StageAgentService prompt must NOT contain node shell-safety guidance with non-node testInfra'
    );
    pass('StageAgentService: node shell-safety guidance absent with non-node testInfra');
  }

  console.log('\n  24/24 assertions passed');
})();
