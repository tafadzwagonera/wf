/**
 * Manual Test Script for the consolidated --repos option
 *
 * Run: nr test:manual -- test-repos-option
 *
 * Verifies that:
 *   1. issue:fetch --help shows -r, --repos and NOT --repo or --affected-repos
 *   2. issue:plan --help shows -r, --repos
 *   3. issue:implement --help shows -r, --repos
 *   4. issue:review --help shows -r, --repos
 *   5. issue:all --help shows -r, --repos
 *   6. issue:generate --help shows -r, --repos
 *   7. None of the above show the old --repo / --affected-repositories flags
 */

import { execSync } from 'child_process';

async function testReposOption() {
  console.log('🧪 Testing consolidated --repos option\n');

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

  const helpOutput = (command: string): string => {
    try {
      return execSync(`node dist/main.js ${command} --help`, {
        encoding: 'utf-8',
        cwd: process.cwd(),
      });
    } catch (err: any) {
      return (err.stdout ?? '') + (err.stderr ?? '');
    }
  };

  const commands = [
    'issue:fetch',
    'issue:plan',
    'issue:implement',
    'issue:review',
    'issue:all',
    'issue:generate',
  ];

  for (const cmd of commands) {
    const help = helpOutput(cmd);

    if (help.includes('-r, --repos')) {
      pass(`${cmd}: -r, --repos present in --help`);
    } else {
      fail(`${cmd}: -r, --repos NOT found in --help`);
    }

    if (help.includes('--repo ') || help.match(/--repo\b(?!s)/)) {
      fail(`${cmd}: old --repo flag still present in --help`);
    } else {
      pass(`${cmd}: old --repo flag correctly absent`);
    }

    if (help.includes('--affected-repositories')) {
      fail(`${cmd}: old --affected-repositories flag still present in --help`);
    } else {
      pass(`${cmd}: old --affected-repositories flag correctly absent`);
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

testReposOption();
