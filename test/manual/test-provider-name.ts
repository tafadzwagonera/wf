/**
 * Manual Test: Provider display name in issue:commit --dry-run output
 *
 * Run: nr test:manual -- test-provider-name
 *
 * Verifies that:
 *   1. Default (anthropic) provider shows 'Anthropic Claude' in dry-run output
 *   2. wf.config.js with openai as default shows 'OpenAI' in dry-run output
 *   3. wf.config.js with google as default shows 'Google Gemini' in dry-run output
 *   4. wf.config.js with deepseek as default shows 'DeepSeek' in dry-run output
 */

import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

function testProviderName() {
  console.log('🧪 Testing provider display names in issue:commit --dry-run\n');

  let passed = 0;
  let failed = 0;

  const pass = (msg: string) => {
    console.log(`✓ ${msg}`);
    passed++;
  };
  const fail = (msg: string, detail?: string) => {
    console.error(`❌ ${msg}${detail ? `\n   → ${detail}` : ''}`);
    failed++;
  };

  const configPath = path.join(process.cwd(), 'wf.config.js');
  const existingConfig = fs.existsSync(configPath) ? fs.readFileSync(configPath, 'utf-8') : null;

  const writeConfig = (provider: string, model: string): void => {
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
  };

  const runDryRun = (provider: string, model: string): string => {
    writeConfig(provider, model);

    try {
      return execSync('node dist/main.js issue:commit --dry-run', {
        encoding: 'utf-8',
        cwd: process.cwd(),
        env: { ...process.env },
      });
    } catch (error: unknown) {
      const stdout =
        typeof error === 'object' && error !== null && 'stdout' in error && typeof error.stdout === 'string'
          ? error.stdout
          : '';
      const stderr =
        typeof error === 'object' && error !== null && 'stderr' in error && typeof error.stderr === 'string'
          ? error.stderr
          : '';
      return stdout + stderr;
    }
  };

  try {
    const anthropicOutput = runDryRun('anthropic', 'claude-sonnet-4-20250514');
    if (anthropicOutput.includes('Anthropic Claude')) {
      pass('Anthropic config shows "Anthropic Claude" in dry-run output');
    } else {
      fail('Anthropic config does NOT show "Anthropic Claude"', anthropicOutput.slice(0, 300));
    }

    const openaiOutput = runDryRun('openai', 'gpt-5.4');
    if (openaiOutput.includes('OpenAI')) {
      pass('OpenAI config shows "OpenAI" in dry-run output');
    } else {
      fail('OpenAI config does NOT show "OpenAI"', openaiOutput.slice(0, 300));
    }

    const geminiOutput = runDryRun('google', 'gemini-2.5-pro');
    if (geminiOutput.includes('Google Gemini')) {
      pass('Gemini config shows "Google Gemini" in dry-run output');
    } else {
      fail('Gemini config does NOT show "Google Gemini"', geminiOutput.slice(0, 300));
    }

    const deepseekOutput = runDryRun('deepseek', 'deepseek-reasoner');
    if (deepseekOutput.includes('DeepSeek')) {
      pass('DeepSeek config shows "DeepSeek" in dry-run output');
    } else {
      fail('DeepSeek config does NOT show "DeepSeek"', deepseekOutput.slice(0, 300));
    }
  } finally {
    if (existingConfig === null) {
      fs.rmSync(configPath, { force: true });
    } else {
      fs.writeFileSync(configPath, existingConfig);
    }
  }

  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`Results: ✅ ${passed} passed   ❌ ${failed} failed`);
  if (failed === 0) {
    console.log('✅ All tests passed!');
  }
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  if (failed > 0) process.exit(1);
}

testProviderName();
