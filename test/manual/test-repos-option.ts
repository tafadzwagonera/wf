/**
 * Manual Test Script for the consolidated --repos option
 *
 * Run: nr test:manual -- test-repos-option
 *
 * Verifies that:
 *   1. issue:fetch --help shows -r, --repos <repos...> and NOT --repo or --affected-repos
 *   2. issue:plan --help shows -r, --repos <repos...>
 *   3. issue:implement --help shows -r, --repos <repos...>
 *   4. issue:review --help shows -r, --repos <repos...>
 *   5. issue --help shows -r, --repos <repos...>
 *   6. issue:generate --help shows -r, --repos <repos...>
 *   7. Help text describes repos as space-separated, not comma-separated
 *   8. None of the above show the old --repo / --affected-repositories flags
 */

import { execSync } from 'child_process';
import * as os from 'os';
import * as path from 'path';

async function testReposOption() {
  console.log('🧪 Testing consolidated --repos option\n');

  let passed = 0;
  let failed = 0;

  const pass = (msg: string) => {
    console.log(`✓ ${msg}`);
    passed++;
  };
  const fail = (msg: string) => {
    console.error(`✗ ${msg}`);
    failed++;
  };

  const helpOutput = (command: string): string => {
    const distMain = path.join(__dirname, '../../dist/main.js');
    try {
      return execSync(`node ${distMain} ${command} --help`, {
        encoding: 'utf-8',
        cwd: os.tmpdir(),
      });
    } catch (err: any) {
      return (err.stdout ?? '') + (err.stderr ?? '');
    }
  };

  const commands = ['issue:fetch', 'issue:plan', 'issue:implement', 'issue:review', 'issue', 'issue:generate'];

  for (const cmd of commands) {
    const help = helpOutput(cmd);

    if (help.includes('-r, --repos <repos...>')) {
      pass(`${cmd}: -r, --repos <repos...> present in --help`);
    } else {
      fail(`${cmd}: -r, --repos <repos...> NOT found in --help`);
    }

    if (/Space-separated(?: list of)? repositories/.test(help)) {
      pass(`${cmd}: help text describes repos as space-separated`);
    } else {
      fail(`${cmd}: help text does not describe repos as space-separated`);
    }

    if (help.includes('Comma-separated list of repositories')) {
      fail(`${cmd}: old comma-separated wording still present in --help`);
    } else {
      pass(`${cmd}: old comma-separated wording correctly absent`);
    }

    if (help.includes('--repo ') || (/--repo\b(?!s)/.exec(help))) {
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
  console.log(`Results: ✓ ${passed} passed   ✗ ${failed} failed`);
  if (failed === 0) {
    console.log('✓ All tests passed!');
  }
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  if (failed > 0) process.exit(1);
}

testReposOption();
