/**
 * Manual Test: stampPlanMetadata uses response metadata instead of global config
 *
 * Run: nr test:manual stamp-plan-metadata.smoke.ts
 *
 * Verifies that plan artifacts stamp provider/source from the actual API
 * response metadata, falling back to stage-resolved config when the response
 * lacks provider or model fields.
 */

import { NestFactory } from '@nestjs/core';
import { AppModule } from '../../src/app.module';
import { AiService } from '../../src/integrations/ai/ai.service';
import { createReporter, summarise } from './support/reporter';

const { counts, pass, fail } = createReporter();

function checkResponseMetadataStamped(plan: { provider?: string; source?: string }): void {
  if (plan.provider === 'anthropic') {
    pass('plan.provider stamped from response metadata (anthropic)');
  } else {
    fail('plan.provider should be "anthropic" from response metadata', `got "${plan.provider}"`);
  }
  if (plan.source === 'opus-4-6') {
    pass('plan.source derived from response model (opus-4-6)');
  } else {
    fail('plan.source should be "opus-4-6" after stripping claude- prefix', `got "${plan.source}"`);
  }
}

function checkFallbackToConfig(plan: { provider?: string; source?: string }): void {
  if (typeof plan.provider === 'string' && plan.provider.length > 0) {
    pass(`plan.provider falls back to config value ("${plan.provider}")`);
  } else {
    fail('plan.provider should fall back to a non-empty config value', `got "${plan.provider}"`);
  }
  if (typeof plan.source === 'string') {
    pass(`plan.source falls back to config-derived value ("${plan.source}")`);
  } else {
    fail('plan.source should fall back to a config-derived string', `got "${plan.source}"`);
  }
}

function checkPartialMetadataFallback(plan: { provider?: string }): void {
  if (plan.provider === 'google') {
    fail('partial metadata (provider only, no model) should fall back to resolveAiTarget', `got provider="${plan.provider}" — expected fallback, not the partial response value`);
  } else {
    pass(`partial metadata (provider only) triggers fallback ("${plan.provider}")`);
  }
}

async function smokeResponseMetadata(aiService: AiService): Promise<void> {
  (AiService.prototype as any).execute = async () => ({
    content: JSON.stringify({ action: 'fix', summary: 'Smoke test: response metadata stamps plan', steps: ['Step 1'], estimatedComplexity: 'low', affectedFiles: ['repo/src/file.ts'], affectedRepositories: ['repo'] }),
    provider: 'anthropic',
    model: 'claude-opus-4-6',
  });
  const plan = await aiService.generatePlan('fix', '# SMOKE-1: Response metadata', { affectedRepositories: ['repo'] });
  checkResponseMetadataStamped(plan);
}

async function smokeFallbackToConfig(aiService: AiService): Promise<void> {
  (AiService.prototype as any).execute = async () => ({
    content: JSON.stringify({ action: 'fix', summary: 'Smoke test: fallback to config', steps: ['Step 1'], estimatedComplexity: 'low', affectedFiles: ['repo/src/file.ts'], affectedRepositories: ['repo'] }),
  });
  const plan = await aiService.generatePlan('fix', '# SMOKE-2: No response metadata', { affectedRepositories: ['repo'] });
  checkFallbackToConfig(plan);
}

async function smokePartialMetadata(aiService: AiService): Promise<void> {
  (AiService.prototype as any).execute = async () => ({
    content: JSON.stringify({ action: 'fix', summary: 'Smoke test: partial metadata', steps: ['Step 1'], estimatedComplexity: 'low', affectedFiles: ['repo/src/file.ts'], affectedRepositories: ['repo'] }),
    provider: 'google',
  });
  const plan = await aiService.generatePlan('fix', '# SMOKE-3: Partial metadata', { affectedRepositories: ['repo'] });
  checkPartialMetadataFallback(plan);
}

async function runAllTests(aiService: AiService): Promise<void> {
  await smokeResponseMetadata(aiService);
  await smokeFallbackToConfig(aiService);
  await smokePartialMetadata(aiService);
}

async function main(): Promise<void> {
  console.log('\n🧪 Manual Test: stampPlanMetadata uses response metadata\n');
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });
  const aiService = app.get(AiService);
  const originalExecute = AiService.prototype.execute;
  try {
    await runAllTests(aiService);
  } finally {
    AiService.prototype.execute = originalExecute;
    await app.close();
  }
  summarise(counts);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
