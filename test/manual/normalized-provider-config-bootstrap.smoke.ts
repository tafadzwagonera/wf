/**
 * Manual smoke test: normalizedAiProviderConfigSchema round-trips through DI container
 *
 * Run: nr test:manual normalized-provider-config-bootstrap.smoke.ts
 *
 * Verifies:
 *   1. App bootstraps without config validation errors
 *   2. First provider: default is true (boolean), model is 'claude-sonnet-4-6' (string)
 *   3. Second provider: default is false (boolean, not undefined), model is the OpenAI default (string)
 *   4. Both provider objects satisfy normalizedAiProviderConfigSchema
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { AppModule } from '../../src/app.module';
import { initializeWfConfig } from '../../src/config/wf-config-loader';
import { normalizedAiProviderConfigSchema } from '../../src/shared/schemas/config.schema';
import { createReporter, summarise } from './support/reporter';

const { counts, pass, fail } = createReporter();

const assert = (label: string, condition: boolean, detail?: string): void => {
  if (condition) pass(label);
  else fail(label, detail);
};

function checkFirstProvider(first: any): void {
  assert('first provider: default is true (boolean)', first.default === true, `got: ${first.default} (${typeof first.default})`);
  assert('first provider: model is claude-sonnet-4-6 (string)', first.model === 'claude-sonnet-4-6', `got: ${first.model}`);
  const firstValid = normalizedAiProviderConfigSchema.safeParse(first);
  assert('first provider satisfies normalizedAiProviderConfigSchema', firstValid.success, `errors: ${JSON.stringify(firstValid.error?.issues)}`);
}

function checkSecondProvider(second: any): void {
  assert('second provider: default is false (boolean, not undefined)', second.default === false, `got: ${second.default} (${typeof second.default})`);
  assert('second provider: model is a non-empty string (OpenAI default)', typeof second.model === 'string' && second.model.length > 0, `got: ${second.model}`);
  const secondValid = normalizedAiProviderConfigSchema.safeParse(second);
  assert('second provider satisfies normalizedAiProviderConfigSchema', secondValid.success, `errors: ${JSON.stringify(secondValid.error?.issues)}`);
}

function checkProviders(providers: any[]): void {
  assert('ai.providers is a non-empty array', Array.isArray(providers) && providers.length === 2, `got: ${JSON.stringify(providers)}`);
  if (providers.length >= 2) {
    checkFirstProvider(providers[0]);
    checkSecondProvider(providers[1]);
  }
}

async function runBootstrapScenario(): Promise<void> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-provider-bootstrap-'));
  fs.writeFileSync(path.join(tempDir, 'wf.config.ts'), ['export default {', '  ai: [', "    { provider: 'anthropic', apiKey: 'k1', model: 'claude-sonnet-4-6', default: true },", "    { provider: 'openai', apiKey: 'k2' },", '  ],', '};'].join('\n'), 'utf-8');
  await initializeWfConfig(tempDir);
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error'] });
  try {
    const configService = app.get(ConfigService);
    assert('app bootstraps without config validation errors', true);
    const providers = configService.get<any[]>('ai.providers');
    checkProviders(providers ?? []);
  } finally {
    await app.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  console.log('\nNormalized provider config bootstrap smoke test\n' + '─'.repeat(60));
  await runBootstrapScenario();
  summarise(counts);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
