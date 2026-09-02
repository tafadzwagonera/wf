/**
 * Manual Test: stampPlanMetadata uses response metadata instead of global config
 *
 * Run: nr test:manual -- test-stamp-plan-metadata
 *
 * Verifies that plan artifacts stamp provider/source from the actual API
 * response metadata, falling back to stage-resolved config when the response
 * lacks provider or model fields.
 */

import { NestFactory } from '@nestjs/core';
import { AppModule } from '../../src/app.module';
import { AiService } from '../../src/integrations/ai/ai.service';
import { createReporter } from './support/reporter';

async function main(): Promise<void> {
  console.log('\n🧪 Manual Test: stampPlanMetadata uses response metadata\n');

  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn'],
  });

  const { counts, pass, fail } = createReporter();

  const aiService = app.get(AiService);
  const originalExecute = AiService.prototype.execute;

  try {
    // Test 1: response metadata stamps plan.provider and plan.source
    (AiService.prototype as any).execute = async () => ({
      content: JSON.stringify({
        action: 'fix',
        summary: 'Smoke test: response metadata stamps plan',
        steps: ['Step 1'],
        estimatedComplexity: 'low',
        affectedFiles: ['repo/src/file.ts'],
        affectedRepositories: ['repo'],
      }),
      provider: 'anthropic',
      model: 'claude-opus-4-6',
    });

    const planWithMetadata = await aiService.generatePlan('fix', '# SMOKE-1: Response metadata', {
      affectedRepositories: ['repo'],
    });

    if (planWithMetadata.provider === 'anthropic') {
      pass('plan.provider stamped from response metadata (anthropic)');
    } else {
      fail(
        'plan.provider should be "anthropic" from response metadata',
        `got "${planWithMetadata.provider}"`
      );
    }

    if (planWithMetadata.source === 'opus-4-6') {
      pass('plan.source derived from response model (opus-4-6)');
    } else {
      fail(
        'plan.source should be "opus-4-6" after stripping claude- prefix',
        `got "${planWithMetadata.source}"`
      );
    }

    // Test 2: fallback to resolveAiTarget when response has no provider/model
    (AiService.prototype as any).execute = async () => ({
      content: JSON.stringify({
        action: 'fix',
        summary: 'Smoke test: fallback to config',
        steps: ['Step 1'],
        estimatedComplexity: 'low',
        affectedFiles: ['repo/src/file.ts'],
        affectedRepositories: ['repo'],
      }),
    });

    const planWithoutMetadata = await aiService.generatePlan('fix', '# SMOKE-2: No response metadata', {
      affectedRepositories: ['repo'],
    });

    if (typeof planWithoutMetadata.provider === 'string' && planWithoutMetadata.provider.length > 0) {
      pass(`plan.provider falls back to config value ("${planWithoutMetadata.provider}")`);
    } else {
      fail('plan.provider should fall back to a non-empty config value', `got "${planWithoutMetadata.provider}"`);
    }

    if (typeof planWithoutMetadata.source === 'string') {
      pass(`plan.source falls back to config-derived value ("${planWithoutMetadata.source}")`);
    } else {
      fail('plan.source should fall back to a config-derived string', `got "${planWithoutMetadata.source}"`);
    }

    // Test 3: partial metadata (provider only) triggers fallback
    (AiService.prototype as any).execute = async () => ({
      content: JSON.stringify({
        action: 'fix',
        summary: 'Smoke test: partial metadata',
        steps: ['Step 1'],
        estimatedComplexity: 'low',
        affectedFiles: ['repo/src/file.ts'],
        affectedRepositories: ['repo'],
      }),
      provider: 'google',
    });

    const planPartial = await aiService.generatePlan('fix', '# SMOKE-3: Partial metadata', {
      affectedRepositories: ['repo'],
    });

    if (planPartial.provider === 'google') {
      fail(
        'partial metadata (provider only, no model) should fall back to resolveAiTarget',
        `got provider="${planPartial.provider}" — expected fallback, not the partial response value`
      );
    } else {
      pass(`partial metadata (provider only) triggers fallback ("${planPartial.provider}")`);
    }
  } finally {
    AiService.prototype.execute = originalExecute;
    await app.close();
  }

  console.log(`\n  ${counts.passed} passed, ${counts.failed} failed\n`);
  if (counts.failed > 0) process.exit(1);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
