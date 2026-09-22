/**
 * Manual Test: Provider display name in issue:commit --dry-run output
 *
 * Run: nr test:manual provider-name.smoke.ts
 *
 * Verifies that:
 *   1. Default (anthropic) provider shows 'Anthropic Claude' in dry-run output
 *   2. wf.config.js with openai as default shows 'OpenAI' in dry-run output
 *   3. wf.config.js with google as default shows 'Google Gemini' in dry-run output
 *   4. wf.config.js with deepseek as default shows 'DeepSeek' in dry-run output
 */

import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createReporter } from './support/reporter';

const { counts, pass, fail } = createReporter();

function extractStdout(error: unknown): string {
  return typeof error === 'object' && error !== null && 'stdout' in error && typeof error.stdout === 'string'
    ? error.stdout
    : '';
}

function extractStderr(error: unknown): string {
  return typeof error === 'object' && error !== null && 'stderr' in error && typeof error.stderr === 'string'
    ? error.stderr
    : '';
}

function writeConfig(provider: string, model: string, configPath: string): void {
  fs.writeFileSync(
    configPath,
    [
      'module.exports = {',
      '  ai: [',
      `    { provider: '${provider}', apiKey: 'test-key', model: '${model}', default: true },`,
      '  ],',
      '};',
      '',
    ].join('\n')
  );
}

function runDryRun(provider: string, model: string, configPath: string): string {
  writeConfig(provider, model, configPath);
  try {
    return execSync('node dist/main.js issue:commit --dry-run', {
      encoding: 'utf-8',
      cwd: process.cwd(),
      env: { ...process.env },
    });
  } catch (error: unknown) {
    return extractStdout(error) + extractStderr(error);
  }
}

function checkProvider(output: string, label: string, marker: string): void {
  if (output.includes(marker)) {
    pass(`${label} shows "${marker}" in dry-run output`);
  } else {
    fail(`${label} does NOT show "${marker}"`, output.slice(0, 300));
  }
}

function restoreConfig(configPath: string, existingConfig: string | null): void {
  if (existingConfig === null) fs.rmSync(configPath, { force: true });
  else fs.writeFileSync(configPath, existingConfig);
}

function printResults(): void {
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`Results: ✓ ${counts.passed} passed   ✗ ${counts.failed} failed`);
  if (counts.failed === 0) console.log('✓ All tests passed!');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  if (counts.failed > 0) process.exit(1);
}

function main(): void {
  console.log('🧪 Testing provider display names in issue:commit --dry-run\n');
  const configPath = path.join(process.cwd(), 'wf.config.js');
  const existingConfig = fs.existsSync(configPath) ? fs.readFileSync(configPath, 'utf-8') : null;
  try {
    checkProvider(runDryRun('anthropic', 'claude-sonnet-4-20250514', configPath), 'Anthropic config', 'Anthropic Claude');
    checkProvider(runDryRun('openai', 'gpt-5.4', configPath), 'OpenAI config', 'OpenAI');
    checkProvider(runDryRun('google', 'gemini-2.5-pro', configPath), 'Gemini config', 'Google Gemini');
    checkProvider(runDryRun('deepseek', 'deepseek-reasoner', configPath), 'DeepSeek config', 'DeepSeek');
  } finally {
    restoreConfig(configPath, existingConfig);
  }
  printResults();
}

main();
