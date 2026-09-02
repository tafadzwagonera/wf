/**
 * Manual smoke test: getProviderEndpoint resolves stage-aware endpoints via DI
 *
 * Run: nr test:manual -- test-provider-endpoint-di-wiring
 *
 * Verifies:
 *   1. AiService.getProviderEndpoint('review') returns '/chat/completions'
 *   2. AiService.getProviderEndpoint('plan') returns '/v1/messages'
 *   3. AiService.getProviderEndpoint('commit') returns '/v1beta/models'
 *   4. AiService.getProviderEndpoint() without stage returns global default endpoint
 *   5. AiService.getProviderDisplayName('review') returns 'OpenAI'
 *   6. AiService.getProviderDisplayName('commit') returns 'Google Gemini'
 *   7. AiService.getProviderDisplayName('plan') returns 'Anthropic Claude'
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import chalk from 'chalk';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../../src/app.module';
import { AiService } from '../../src/integrations/ai/ai.service';
import { createReporter } from './support/reporter';

const { counts, pass, fail } = createReporter();

const assert = (label: string, condition: boolean, detail?: string): void => {
  if (condition) {
    pass(label);
    return;
  }
  fail(label, detail);
};

const configPath = path.join(process.cwd(), 'wf.config.js');
const existingConfig = fs.existsSync(configPath) ? fs.readFileSync(configPath, 'utf-8') : null;

async function main(): Promise<void> {
  console.log(chalk.bold.cyan('\nProvider endpoint DI wiring smoke test\n'));

  fs.writeFileSync(
    configPath,
    [
      "const { defineConfig } = require('./dist/config/public-config');",
      'module.exports = defineConfig({',
      '  ai: [',
      "    { provider: 'anthropic', model: 'claude-sonnet-4-6', apiKey: 'k' },",
      "    { provider: 'openai', model: 'gpt-5.4', default: true, apiKey: 'k' },",
      "    { provider: 'google', model: 'gemini-2.5-flash', apiKey: 'k' },",
      '  ],',
      '  stages: {',
      "    review: { provider: 'openai', model: 'gpt-5.4-mini', backend: 'cli' },",
      "    plan: { provider: 'anthropic', backend: 'cli' },",
      "    commit: { provider: 'google', backend: 'standard' },",
      '  },',
      '});',
      '',
    ].join('\n')
  );

  const app = await NestFactory.createApplicationContext(AppModule, { logger: false });

  try {
    const aiService = app.get(AiService);

    // Endpoint resolution
    console.log(chalk.bold('Endpoint resolution'));
    const reviewEndpoint = aiService.getProviderEndpoint('review');
    assert("getProviderEndpoint('review') returns '/chat/completions'",
      reviewEndpoint === '/chat/completions',
      `Got: ${reviewEndpoint}`);

    const planEndpoint = aiService.getProviderEndpoint('plan');
    assert("getProviderEndpoint('plan') returns '/v1/messages'",
      planEndpoint === '/v1/messages',
      `Got: ${planEndpoint}`);

    const commitEndpoint = aiService.getProviderEndpoint('commit');
    assert("getProviderEndpoint('commit') returns '/v1beta/models'",
      commitEndpoint === '/v1beta/models',
      `Got: ${commitEndpoint}`);

    const globalEndpoint = aiService.getProviderEndpoint();
    assert("getProviderEndpoint() without stage returns '/chat/completions' (global default openai)",
      globalEndpoint === '/chat/completions',
      `Got: ${globalEndpoint}`);

    // Display name resolution
    console.log(chalk.bold('\nDisplay name resolution'));
    const reviewName = aiService.getProviderDisplayName('review');
    assert("getProviderDisplayName('review') returns 'OpenAI'",
      reviewName === 'OpenAI',
      `Got: ${reviewName}`);

    const commitName = aiService.getProviderDisplayName('commit');
    assert("getProviderDisplayName('commit') returns 'Google Gemini'",
      commitName === 'Google Gemini',
      `Got: ${commitName}`);

    const planName = aiService.getProviderDisplayName('plan');
    assert("getProviderDisplayName('plan') returns 'Anthropic Claude'",
      planName === 'Anthropic Claude',
      `Got: ${planName}`);
  } finally {
    await app.close();

    if (existingConfig === null) {
      fs.rmSync(configPath, { force: true });
    } else {
      fs.writeFileSync(configPath, existingConfig);
    }
  }

  console.log(
    chalk.bold(
      `\n${counts.passed + counts.failed} assertions: ${chalk.green(`${counts.passed} passed`)}${counts.failed > 0 ? `, ${chalk.red(`${counts.failed} failed`)}` : ''}`
    )
  );

  if (counts.failed > 0) {
    process.exit(1);
  }
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
