/**
 * Manual smoke test: Model routing respects user config
 *
 * Run: nr test:manual -- test-model-routing-user-config
 *
 * Verifies:
 *   1. normalizeWfConfig strips provider-level model when models is present.
 *   2. normalizeWfConfig preserves model when models is absent.
 *   3. normalizeWfConfig falls back to provider model when neither model nor models is set.
 *   4. resolveModelRouting uses singleModel for mechanical tasks when no models.mechanical is set.
 *   5. resolveModelRouting prefers models.mechanical over singleModel.
 *   6. resolveModelRouting uses hardcoded default when no config is set.
 *
 * @returns Promise that resolves when the smoke test completes
 */
import chalk from 'chalk';
import { normalizeWfConfig } from '../../src/config/wf-config-loader';
import { resolveModelRouting } from '../../src/integrations/ai/adapters/shared-routing';
import type { ConfigService } from '@nestjs/config';

let passed = 0;
let failed = 0;

const assert = (label: string, condition: boolean, detail?: string): void => {
  if (condition) {
    console.log(chalk.green(`  ✓ ${label}`));
    passed++;
  } else {
    console.log(chalk.red(`  ✗ ${label}${detail ? `\n    → ${detail}` : ''}`));
    failed++;
  }
};

const createMockConfigService = (configMap: Record<string, unknown>): ConfigService =>
  ({ get: (key: string) => configMap[key] }) as unknown as ConfigService;

const run = async (): Promise<void> => {
  console.log(chalk.bold('\nSmoke test: Model routing respects user config\n'));

  console.log(chalk.bold('1. normalizeWfConfig strips model when models is present'));
  const cfg1 = normalizeWfConfig({
    ai: [{ provider: 'anthropic', apiKey: 'k', model: 'claude-sonnet-4-20250514', default: true }],
    stages: {
      implement: {
        provider: 'anthropic',
        models: { default: 'claude-opus-4-6', mechanical: 'claude-haiku-4-5-20251001' },
      },
    },
  });
  assert('models is set', cfg1.stages.implement?.models?.mechanical === 'claude-haiku-4-5-20251001');
  assert('model is stripped', cfg1.stages.implement?.model === undefined, `got: ${cfg1.stages.implement?.model}`);

  console.log(chalk.bold('\n2. normalizeWfConfig preserves model when models is absent'));
  const cfg2 = normalizeWfConfig({
    ai: [{ provider: 'anthropic', apiKey: 'k', model: 'claude-sonnet-4-20250514', default: true }],
    stages: { implement: { provider: 'anthropic', model: 'claude-opus-4-6' } },
  });
  assert('model is preserved', cfg2.stages.implement?.model === 'claude-opus-4-6', `got: ${cfg2.stages.implement?.model}`);
  assert('models is absent', cfg2.stages.implement?.models === undefined);

  console.log(chalk.bold('\n3. normalizeWfConfig falls back to provider model'));
  const cfg3 = normalizeWfConfig({
    ai: [{ provider: 'anthropic', apiKey: 'k', model: 'claude-sonnet-4-20250514', default: true }],
    stages: { implement: { provider: 'anthropic' } },
  });
  assert(
    'model is provider fallback',
    cfg3.stages.implement?.model === 'claude-sonnet-4-20250514',
    `got: ${cfg3.stages.implement?.model}`
  );

  console.log(chalk.bold('\n4. resolveModelRouting: singleModel overrides mechanical fallback'));
  const mockCfg4 = createMockConfigService({
    'stages.implement.model': 'claude-opus-4-6',
    'stages.implement.models': undefined,
  });
  const result4 = resolveModelRouting({
    routing: 'auto',
    fallbackDefaultModel: 'claude-sonnet-4-6',
    defaultMechanicalModel: 'claude-haiku-4-5-20251001',
    configService: mockCfg4,
    plan: { action: 'fix', summary: 'test', steps: ['step'], estimatedComplexity: 'low' },
    adapterLabel: 'test',
  });
  assert(
    'mechanical task uses singleModel, not hardcoded haiku',
    result4.model === 'claude-opus-4-6',
    `got: ${result4.model}`
  );

  console.log(chalk.bold('\n5. resolveModelRouting: models.mechanical takes precedence'));
  const mockCfg5 = createMockConfigService({
    'stages.implement.model': undefined,
    'stages.implement.models': { mechanical: 'claude-haiku-custom' },
  });
  const result5 = resolveModelRouting({
    routing: 'auto',
    fallbackDefaultModel: 'claude-sonnet-4-6',
    defaultMechanicalModel: 'claude-haiku-4-5-20251001',
    configService: mockCfg5,
    plan: { action: 'fix', summary: 'test', steps: ['step'], estimatedComplexity: 'low' },
    adapterLabel: 'test',
  });
  assert(
    'models.mechanical wins over fallback',
    result5.model === 'claude-haiku-custom',
    `got: ${result5.model}`
  );

  console.log(chalk.bold('\n6. resolveModelRouting: hardcoded default when no config'));
  const mockCfg6 = createMockConfigService({
    'stages.implement.model': undefined,
    'stages.implement.models': undefined,
  });
  const result6 = resolveModelRouting({
    routing: 'auto',
    fallbackDefaultModel: 'claude-sonnet-4-6',
    defaultMechanicalModel: 'claude-haiku-4-5-20251001',
    configService: mockCfg6,
    plan: { action: 'fix', summary: 'test', steps: ['step'], estimatedComplexity: 'low' },
    adapterLabel: 'test',
  });
  assert(
    'uses defaultMechanicalModel',
    result6.model === 'claude-haiku-4-5-20251001',
    `got: ${result6.model}`
  );

  console.log(chalk.bold(`\nResults: ${passed} passed, ${failed} failed\n`));
  if (failed > 0) process.exit(1);
};

run();
