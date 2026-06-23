/**
 * Manual test script for .prettierrc configuration alignment.
 *
 * Verifies that the project .prettierrc contains the expected settings
 * matching the service-bookingv3 pattern, and that the codebase is
 * already formatted according to those settings.
 *
 * Run: nr test:manual -- test-prettierrc-config
 *
 * No external APIs or environment variables required.
 */

import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';

interface PrettierConfig {
  tabWidth?: number;
  useTabs?: boolean;
  singleQuote?: boolean;
  semi?: boolean;
  bracketSpacing?: boolean;
  arrowParens?: string;
  trailingComma?: string;
  bracketSameLine?: boolean;
  printWidth?: number;
  endOfLine?: string;
}

async function testPrettierrcConfig() {
  console.log('🧪 Testing .prettierrc configuration alignment\n');

  const root = path.resolve(__dirname, '../..');
  const prettierrcPath = path.join(root, '.prettierrc');

  let passed = 0;
  let failed = 0;

  const pass = (msg: string) => {
    console.log(`  ✅ PASS  ${msg}`);
    passed++;
  };
  const fail = (msg: string) => {
    console.error(`  ❌ FAIL  ${msg}`);
    failed++;
  };

  // ── Test 1: .prettierrc exists ──────────────────────────────────────────

  console.log('Test 1: .prettierrc file exists');
  if (fs.existsSync(prettierrcPath)) {
    pass('.prettierrc exists');
  } else {
    fail('.prettierrc not found');
    console.log('\n' + '━'.repeat(50));
    console.log(`Results: ${passed} passed   ${failed} failed`);
    console.log('━'.repeat(50));
    process.exit(1);
  }

  // ── Test 2: .prettierrc contains expected settings ──────────────────────

  console.log('Test 2: .prettierrc contains expected settings');
  const config: PrettierConfig = JSON.parse(fs.readFileSync(prettierrcPath, 'utf-8'));

  const expectedSettings: PrettierConfig = {
    tabWidth: 2,
    useTabs: false,
    singleQuote: true,
    semi: true,
    bracketSpacing: true,
    arrowParens: 'avoid',
    trailingComma: 'es5',
    bracketSameLine: true,
    printWidth: 120,
    endOfLine: 'auto',
  };

  for (const [key, expected] of Object.entries(expectedSettings)) {
    const actual = config[key as keyof PrettierConfig];
    if (actual === expected) {
      pass(`${key}: ${JSON.stringify(actual)}`);
    } else {
      fail(`${key}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    }
  }

  // ── Test 3: no legacy settings remain ───────────────────────────────────

  console.log('Test 3: no legacy settings remain');
  const legacyKeys = ['proseWrap'];
  for (const key of legacyKeys) {
    if (key in config) {
      fail(`legacy setting "${key}" still present`);
    } else {
      pass(`legacy setting "${key}" removed`);
    }
  }

  if ((config as Record<string, unknown>).trailingComma === 'all') {
    fail('trailingComma still set to legacy value "all"');
  } else {
    pass('trailingComma migrated from "all" to "es5"');
  }

  // ── Test 4: codebase is formatted according to config ───────────────────

  console.log('Test 4: codebase is formatted according to .prettierrc');
  try {
    const result = execSync('npx prettier --check "src/**/*.ts"', {
      cwd: root,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    pass('all src/**/*.ts files pass prettier --check');
  } catch (err: unknown) {
    const stderr = (err as { stderr?: string }).stderr ?? '';
    const unformatted = stderr
      .split('\n')
      .filter(l => l.includes('.ts'))
      .slice(0, 5);
    fail(`some files are not formatted:\n${unformatted.join('\n')}`);
  }

  // ── Summary ─────────────────────────────────────────────────────────────

  console.log('\n' + '━'.repeat(50));
  console.log(`Results: ${passed} passed   ${failed} failed`);
  if (failed === 0) console.log('All tests passed!');
  console.log('━'.repeat(50));

  if (failed > 0) process.exit(1);
}

testPrettierrcConfig();
