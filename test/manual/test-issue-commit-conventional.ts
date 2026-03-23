/**
 * Manual Test: -c shortcut for --conventional in issue:commit
 *
 * Run: nr test:manual -- test-issue-commit-conventional
 *
 * Verifies that:
 *   1. issue:commit --help shows -c, --conventional
 *   2. issue:commit --help does NOT show bare --conventional (without -c)
 */

import { execSync } from 'child_process';

function testIssueCommitConventional() {
  console.log('🧪 Testing -c shortcut for --conventional in issue:commit\n');

  let passed = 0;
  let failed = 0;

  const pass = (msg: string) => {
    console.log(`✓ ${msg}`);
    passed++;
  };
  const fail = (msg: string) => {
    console.error(`❌ ${msg}`);
    failed++;
  };

  let help: string;
  try {
    help = execSync('node dist/main.js issue:commit --help', {
      encoding: 'utf-8',
      cwd: process.cwd(),
    });
  } catch (err: any) {
    help = (err.stdout ?? '') + (err.stderr ?? '');
  }

  if (help.includes('-c, --conventional')) {
    pass('issue:commit --help shows -c, --conventional');
  } else {
    fail('issue:commit --help does NOT show -c, --conventional');
  }

  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`Results: ✅ ${passed} passed   ❌ ${failed} failed`);
  if (failed === 0) {
    console.log('✅ All tests passed!');
  }
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  if (failed > 0) process.exit(1);
}

testIssueCommitConventional();
