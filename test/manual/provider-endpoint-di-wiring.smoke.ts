/**
 * Manual smoke test: getProviderEndpoint resolves stage-aware endpoints via DI
 *
 * Run: nr test:manual provider-endpoint-di-wiring.smoke.ts
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

function buildAiEntries(): string[] {
  return [
    "    { provider: 'anthropic', model: 'claude-sonnet-4-6', apiKey: 'k' },",
    "    { provider: 'openai', model: 'gpt-5.4', default: true, apiKey: 'k' },",
    "    { provider: 'google', model: 'gemini-2.5-flash', apiKey: 'k' },",
  ];
}

function buildStageEntries(): string[] {
  return [
    "    review: { provider: 'openai', model: 'gpt-5.4-mini', backend: 'cli' },",
    "    plan: { provider: 'anthropic', backend: 'cli' },",
    "    commit: { provider: 'google', backend: 'standard' },",
  ];
}

function writeTestConfig(): void {
  fs.writeFileSync(configPath, [
    "const { defineConfig } = require('./dist/config/public-config');",
    'module.exports = defineConfig({',
    '  ai: [',
    ...buildAiEntries(),
    '  ],',
    '  stages: {',
    ...buildStageEntries(),
    '  },',
    '});',
    '',
  ].join('\n'));
}

function restoreConfig(): void {
  if (existingConfig === null) fs.rmSync(configPath, { force: true });
  else fs.writeFileSync(configPath, existingConfig);
}

function printSummary(): void {
  const total = counts.passed + counts.failed;
  const passedStr = chalk.green(`${counts.passed} passed`);
  const failedStr = counts.failed > 0 ? `, ${chalk.red(`${counts.failed} failed`)}` : '';
  console.log(chalk.bold(`\n${total} assertions: ${passedStr}${failedStr}`));
  if (counts.failed > 0) process.exit(1);
}

function checkEndpoints(aiService: AiService): void {
  console.log(chalk.bold('Endpoint resolution'));
  const re = aiService.getProviderEndpoint('review');
  assert("getProviderEndpoint('review') returns '/chat/completions'", re === '/chat/completions', `Got: ${re}`);
  const pe = aiService.getProviderEndpoint('plan');
  assert("getProviderEndpoint('plan') returns '/v1/messages'", pe === '/v1/messages', `Got: ${pe}`);
  const ce = aiService.getProviderEndpoint('commit');
  assert("getProviderEndpoint('commit') returns '/v1beta/models'", ce === '/v1beta/models', `Got: ${ce}`);
  const ge = aiService.getProviderEndpoint();
  assert("getProviderEndpoint() returns global default '/chat/completions'", ge === '/chat/completions', `Got: ${ge}`);
}

function checkDisplayNames(aiService: AiService): void {
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
}

async function main(): Promise<void> {
  console.log(chalk.bold.cyan('\nProvider endpoint DI wiring smoke test\n'));
  writeTestConfig();
  const app = await NestFactory.createApplicationContext(AppModule, { logger: false });
  try {
    const aiService = app.get(AiService);
    checkEndpoints(aiService);
    checkDisplayNames(aiService);
  } finally {
    await app.close();
    restoreConfig();
  }
  printSummary();
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
