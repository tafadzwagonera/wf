/**
 * Manual smoke test: model routing resolves from stage provider, not global default
 *
 * Run: nr test:manual -- test-model-routing-cross-provider
 *
 * Scenario: The user configures multiple AI providers with `default: true` on a
 * provider that differs from the implement stage's provider. Model routing for
 * the implement stage must resolve the fallback default model from the stage's
 * own provider — not from the global default.
 *
 * Verifies:
 *   1. normalizeWfConfig produces ai.model = 'gpt-5.4' (global default is OpenAI)
 *   2. normalizeWfConfig produces stages.implement.model = undefined (stripped by normalizer)
 *   3. resolveProviderModel returns the anthropic provider's model, not the global default
 *   4. resolveProviderModel returns the openai provider's model
 *   5. resolveProviderModel falls back to the hardcoded default when the provider is absent
 *   6. resolveModelRouting for a creative task uses the stage provider's model
 *   7. resolveModelRouting for a mechanical task uses the hardcoded mechanical default
 *
 * @returns void
 */
import chalk from 'chalk';
import { ConfigService } from '@nestjs/config';
import { normalizeWfConfig } from '../../src/config/wf-config-loader';
import { resolveProviderModel, resolveModelRouting } from '../../src/integrations/ai/adapters/shared-routing';
import type { ResolutionPlan } from '../../src/integrations/ai/ai.service';

let passed = 0;
let failed = 0;

const pass = (message: string): void => {
  console.log(chalk.green(`  ✓ ${message}`));
  passed += 1;
};

const fail = (message: string, detail?: string): void => {
  console.log(chalk.red(`  ✗ ${message}`));
  if (detail) console.log(chalk.red(`    ${detail}`));
  failed += 1;
};

const assert = (label: string, condition: boolean, detail?: string): void => {
  if (condition) pass(label);
  else fail(label, detail);
};

const MECHANICAL_MODEL = 'claude-haiku-4-5-20251001';

const createConfigService = (flatConfig: Record<string, unknown>): ConfigService => {
  const svc = new ConfigService();
  const originalGet = svc.get.bind(svc);
  svc.get = ((key: string) => {
    if (key in flatConfig) return flatConfig[key];
    return originalGet(key);
  }) as typeof svc.get;
  return svc;
};

const createPlan = (complexity: 'low' | 'medium' | 'high'): ResolutionPlan => ({
  action: 'fix' as const,
  summary: 'Test plan',
  steps: ['Step 1'],
  estimatedComplexity: complexity,
  affectedFiles: complexity === 'low' ? Array(3).fill({ filePath: 'src/a.ts', status: 'found' as const }) : [],
});

function main(): void {
  console.log(chalk.bold('\nModel routing cross-provider smoke test\n'));

  const config = normalizeWfConfig({
    ai: [
      { provider: 'anthropic', model: 'claude-sonnet-4-6', apiKey: 'k' },
      { provider: 'openai', model: 'gpt-5.4', default: true, apiKey: 'k' },
    ],
    stages: {
      implement: { provider: 'anthropic', backend: 'cli' },
    },
  });

  // 1. ai.model is the global default (OpenAI)
  assert(
    'ai.model is the global default provider model (gpt-5.4)',
    config.ai.model === 'gpt-5.4',
    `got: ${config.ai.model}`,
  );

  // 2. stages.implement.model is stripped (not injected from provider)
  assert(
    'stages.implement.model is undefined (stripped by normalizer)',
    config.stages.implement?.model === undefined,
    `got: ${config.stages.implement?.model}`,
  );

  const configService = createConfigService({
    'ai.model': config.ai.model,
    'ai.providers': config.ai.providers,
    'stages.implement.model': config.stages.implement?.model,
    'stages.implement.models': (config.stages.implement as Record<string, unknown>)?.models,
  });

  // 3. resolveProviderModel returns anthropic's model
  const anthropicModel = resolveProviderModel(configService, 'anthropic', 'fallback');
  assert(
    'resolveProviderModel(anthropic) returns claude-sonnet-4-6',
    anthropicModel === 'claude-sonnet-4-6',
    `got: ${anthropicModel}`,
  );

  // 4. resolveProviderModel returns openai's model
  const openaiModel = resolveProviderModel(configService, 'openai', 'fallback');
  assert(
    'resolveProviderModel(openai) returns gpt-5.4',
    openaiModel === 'gpt-5.4',
    `got: ${openaiModel}`,
  );

  // 5. resolveProviderModel falls back for absent provider
  const absentModel = resolveProviderModel(configService, 'deepseek', 'deepseek-chat');
  assert(
    'resolveProviderModel(deepseek) falls back to hardcoded default',
    absentModel === 'deepseek-chat',
    `got: ${absentModel}`,
  );

  // 6. Creative task uses stage provider's model, not global default
  const creativeResult = resolveModelRouting({
    routing: 'auto',
    fallbackDefaultModel: resolveProviderModel(configService, 'anthropic', 'claude-sonnet-4-6'),
    defaultMechanicalModel: MECHANICAL_MODEL,
    configService,
    plan: createPlan('high'),
    adapterLabel: 'test',
  });
  assert(
    'creative task selects anthropic model (claude-sonnet-4-6), not global default (gpt-5.4)',
    creativeResult.model === 'claude-sonnet-4-6',
    `got: ${creativeResult.model}`,
  );

  // 7. Mechanical task uses hardcoded mechanical default
  const mechanicalResult = resolveModelRouting({
    routing: 'auto',
    fallbackDefaultModel: resolveProviderModel(configService, 'anthropic', 'claude-sonnet-4-6'),
    defaultMechanicalModel: MECHANICAL_MODEL,
    configService,
    plan: createPlan('low'),
    adapterLabel: 'test',
  });
  assert(
    'mechanical task selects haiku, not sonnet or gpt-5.4',
    mechanicalResult.model === MECHANICAL_MODEL,
    `got: ${mechanicalResult.model}`,
  );

  // Summary
  console.log(
    chalk.bold(
      `\n${passed + failed} assertions: ${chalk.green(`${passed} passed`)}${failed > 0 ? `, ${chalk.red(`${failed} failed`)}` : ''}`
    )
  );

  if (failed > 0) process.exit(1);
}

main();
