/**
 * Manual smoke test: normalizedAiProviderConfigSchema round-trips through DI container
 *
 * Run: nr test:manual -- test-normalized-provider-config-bootstrap
 *
 * Verifies:
 *   1. App bootstraps without config validation errors
 *   2. First provider: default is true (boolean), model is 'claude-sonnet-4-6' (string)
 *   3. Second provider: default is false (boolean, not undefined), model is the OpenAI default (string)
 *   4. Both provider objects satisfy normalizedAiProviderConfigSchema
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { AppModule } from '../../src/app.module';
import { initializeWfConfig } from '../../src/config/wf-config-loader';
import { normalizedAiProviderConfigSchema } from '../../src/shared/schemas/config.schema';

let passed = 0;
let failed = 0;

const pass = (message: string): void => {
  console.log(`  ✓ ${message}`);
  passed++;
};

const fail = (message: string, detail?: string): void => {
  console.error(`  ✗ ${message}${detail ? `\n    → ${detail}` : ''}`);
  failed++;
};

const assert = (label: string, condition: boolean, detail?: string): void => {
  if (condition) pass(label);
  else fail(label, detail);
};

async function main() {
  console.log('\nNormalized provider config bootstrap smoke test\n' + '─'.repeat(60));

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-provider-bootstrap-'));
  fs.writeFileSync(
    path.join(tempDir, 'wf.config.ts'),
    [
      'export default {',
      '  ai: [',
      "    { provider: 'anthropic', apiKey: 'k1', model: 'claude-sonnet-4-6', default: true },",
      "    { provider: 'openai', apiKey: 'k2' },",
      '  ],',
      '};',
    ].join('\n'),
    'utf-8'
  );

  await initializeWfConfig(tempDir);
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error'] });
  const configService = app.get(ConfigService);

  assert('app bootstraps without config validation errors', true);

  const providers = configService.get<any[]>('ai.providers');
  assert('ai.providers is a non-empty array', Array.isArray(providers) && providers.length === 2, `got: ${JSON.stringify(providers)}`);

  if (providers && providers.length >= 2) {
    const [first, second] = providers;

    assert(
      'first provider: default is true (boolean)',
      first.default === true,
      `got: ${first.default} (${typeof first.default})`
    );
    assert(
      'first provider: model is claude-sonnet-4-6 (string)',
      first.model === 'claude-sonnet-4-6',
      `got: ${first.model}`
    );

    assert(
      'second provider: default is false (boolean, not undefined)',
      second.default === false,
      `got: ${second.default} (${typeof second.default})`
    );
    assert(
      'second provider: model is a non-empty string (OpenAI default)',
      typeof second.model === 'string' && second.model.length > 0,
      `got: ${second.model}`
    );

    const firstValid = normalizedAiProviderConfigSchema.safeParse(first);
    assert(
      'first provider satisfies normalizedAiProviderConfigSchema',
      firstValid.success,
      `errors: ${JSON.stringify(firstValid.error?.issues)}`
    );

    const secondValid = normalizedAiProviderConfigSchema.safeParse(second);
    assert(
      'second provider satisfies normalizedAiProviderConfigSchema',
      secondValid.success,
      `errors: ${JSON.stringify(secondValid.error?.issues)}`
    );
  }

  await app.close();
  fs.rmSync(tempDir, { recursive: true, force: true });

  console.log(
    `\n${passed + failed} assertions: ${passed} passed${failed > 0 ? `, ${failed} failed` : ''}\n`
  );
  if (failed > 0) process.exit(1);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
