/**
 * Manual test script for issue:cowsay command.
 *
 * Run: nr test:manual -- test-cowsay
 *
 * No external APIs or environment variables required.
 */

import { NestFactory } from '@nestjs/core';
import { AppModule } from '../../src/app.module';
import { IssueCowsayCommand } from '../../src/commands/issue-cowsay.command';

async function testCowsay() {
  console.log('🧪 Testing issue:cowsay command\n');

  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn'],
  });

  const command = app.get(IssueCowsayCommand);

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

  // ── Test 1: run() completes without throwing ─────────────────────────────

  console.log('Test 1: run() completes without throwing');
  const lines: string[] = [];
  const originalLog = console.log.bind(console);
  console.log = (...args: unknown[]) => lines.push(args.join(' '));

  try {
    await command.run();
    console.log = originalLog;
    pass('run() completed without error');
  } catch (err: unknown) {
    console.log = originalLog;
    fail(`run() threw unexpectedly: ${(err as Error).message}`);
  }

  // ── Test 2: output includes the package version ───────────────────────────

  console.log('Test 2: output contains package version');

  const pkgVersion = (require('../../package.json') as { version: string }).version;
  const hasVersion = lines.some(l => l.includes(pkgVersion));
  if (hasVersion) {
    pass(`Output contains version ${pkgVersion}`);
  } else {
    fail(`Output missing version ${pkgVersion}. Lines:\n${lines.join('\n')}`);
  }

  // ── Test 3: output includes cow ASCII art ─────────────────────────────────

  console.log('Test 3: output contains cow ASCII art');
  const hasCow = lines.some(l => l.includes('(oo)'));
  if (hasCow) {
    pass('Output contains cow ASCII art');
  } else {
    fail('Output missing cow ASCII art');
  }

  // ── Summary ───────────────────────────────────────────────────────────────

  console.log('\n' + '━'.repeat(50));
  console.log(`Results: ${passed} passed   ${failed} failed`);
  if (failed === 0) console.log('All tests passed!');
  console.log('━'.repeat(50));

  await app.close();
  if (failed > 0) process.exit(1);
}

testCowsay();
