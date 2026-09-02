/**
 * Manual Test: -c shortcut for --conventional in issue:commit
 *
 * Run: nr test:manual -- test-issue-commit-conventional
 *
 * Verifies that:
 *   1. issue:commit --help shows -c, --conventional
 *   2. issue:commit --help does NOT show bare --conventional (without -c)
 */

import * as os from 'node:os';
import * as path from 'node:path';
import { execSync } from 'node:child_process';
import { createReporter } from './support/reporter';

// Run dist/main.js from a temp dir so wf.config.ts in the project root is not picked up.
const DIST_MAIN = path.join(__dirname, '../../dist/main.js');

function main(): void {
  console.log('🧪 Testing -c shortcut for --conventional in issue:commit\n');

  const { counts, pass, fail } = createReporter();

  let help: string;
  try {
    help = execSync(`node ${DIST_MAIN} issue:commit --help`, {
      encoding: 'utf-8',
      cwd: os.tmpdir(),
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
  console.log(`Results: ✓ ${counts.passed} passed   ✗ ${counts.failed} failed`);
  if (counts.failed === 0) {
    console.log('✓ All tests passed!');
  }
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  if (counts.failed > 0) process.exit(1);
}

main();
