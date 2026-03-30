/**
 * Manual Test: Provider display name in issue:commit --dry-run output
 *
 * Run: nr test:manual -- test-provider-name
 *
 * Verifies that:
 *   1. Default (anthropic) provider shows 'Anthropic Claude' in dry-run output
 *   2. AI_PROVIDER=openai shows 'OpenAI' in dry-run output
 *   3. AI_PROVIDER=gemini shows 'Google Gemini' in dry-run output
 *   4. AI_PROVIDER=deepseek shows 'DeepSeek' in dry-run output
 */

import { execSync } from 'child_process';

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

  const runDryRun = (env: Record<string, string>): string => {
    try {
      return execSync('node dist/main.js issue:commit --dry-run', {
        encoding: 'utf-8',
        cwd: process.cwd(),
        env: { ...process.env, ...env },
      });
    } catch (error: unknown) {
      const stdout =
        typeof error === 'object' &&
        error !== null &&
        'stdout' in error &&
        typeof error.stdout === 'string'
          ? error.stdout
          : '';
      const stderr =
        typeof error === 'object' &&
        error !== null &&
        'stderr' in error &&
        typeof error.stderr === 'string'
          ? error.stderr
          : '';
      return stdout + stderr;
    }
  };

  // 1. Anthropic (default)
  const anthropicOutput = runDryRun({ AI_PROVIDER: 'anthropic' });
  if (anthropicOutput.includes('Anthropic Claude')) {
    pass('AI_PROVIDER=anthropic shows "Anthropic Claude" in dry-run output');
  } else {
    fail(
      'AI_PROVIDER=anthropic does NOT show "Anthropic Claude"',
      anthropicOutput.slice(0, 300),
    );
  }

  // 2. OpenAI
  const openaiOutput = runDryRun({ AI_PROVIDER: 'openai' });
  if (openaiOutput.includes('OpenAI')) {
    pass('AI_PROVIDER=openai shows "OpenAI" in dry-run output');
  } else {
    fail(
      'AI_PROVIDER=openai does NOT show "OpenAI"',
      openaiOutput.slice(0, 300),
    );
  }

  // 3. Google Gemini
  const geminiOutput = runDryRun({ AI_PROVIDER: 'gemini' });
  if (geminiOutput.includes('Google Gemini')) {
    pass('AI_PROVIDER=gemini shows "Google Gemini" in dry-run output');
  } else {
    fail(
      'AI_PROVIDER=gemini does NOT show "Google Gemini"',
      geminiOutput.slice(0, 300),
    );
  }

  // 4. DeepSeek
  const deepseekOutput = runDryRun({ AI_PROVIDER: 'deepseek' });
  if (deepseekOutput.includes('DeepSeek')) {
    pass('AI_PROVIDER=deepseek shows "DeepSeek" in dry-run output');
  } else {
    fail(
      'AI_PROVIDER=deepseek does NOT show "DeepSeek"',
      deepseekOutput.slice(0, 300),
    );
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
