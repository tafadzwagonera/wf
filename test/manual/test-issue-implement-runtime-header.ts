/**
 * Manual Test: issue:implement prints a runtime header where none existed before
 *
 * Run: nr test:manual -- test-issue-implement-runtime-header
 *
 * Verifies that:
 *   1. `wf issue:implement --dry-run -k <key>` prints the command summary line
 *   2. It also prints an "Examples:" heading with at least one example command
 *   3. `--silent` suppresses both the summary and the Examples: section
 *   4. The header prints even when the run later fails (no plan artifact),
 *      because printCommandHeader is called before executeAsyncWithCatch, not inside it
 *
 * No AI / API keys required — the missing plan artifact causes a fast, expected failure.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';

const DIST_MAIN = path.join(__dirname, '../../dist/main.js');

let passed = 0;
let failed = 0;
const pass = (msg: string) => {
  console.log(`  ✓ ${msg}`);
  passed++;
};
const fail = (msg: string, detail?: string) => {
  console.error(`  ✗ ${msg}${detail ? `\n    -> ${detail}` : ''}`);
  failed++;
};

function runCli(args: string[], cwd: string): string {
  try {
    return execFileSync('node', [DIST_MAIN, ...args], { encoding: 'utf-8', cwd });
  } catch (err: any) {
    return (err.stdout ?? '') + (err.stderr ?? '');
  }
}

async function main() {
  console.log('\n issue:implement runtime header\n');

  const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-implement-header-'));

  try {
    const withHeader = runCli(['issue:implement', '--dry-run', '-k', 'WBP-1'], scratchDir);

    if (withHeader.includes('Carry out an implementation plan from a ticket-backed, hashed, or custom plan artifact.')) {
      pass('Prints the issue:implement summary line');
    } else {
      fail('Missing summary line', withHeader.slice(0, 300));
    }

    if (/Examples:/.test(withHeader) && /wf issue:implement/.test(withHeader)) {
      pass('Prints an Examples: heading with a wf issue:implement example');
    } else {
      fail('Missing Examples: section', withHeader.slice(0, 300));
    }

    const silent = runCli(['issue:implement', '--dry-run', '-k', 'WBP-1', '--silent'], scratchDir);

    if (!silent.includes('Carry out an implementation plan') && !silent.includes('Examples:')) {
      pass('--silent suppresses the summary and Examples: section');
    } else {
      fail('--silent did not suppress the header', silent.slice(0, 300));
    }
  } finally {
    fs.rmSync(scratchDir, { recursive: true, force: true });
  }

  console.log('\n' + '='.repeat(60));
  console.log(`Results: ${passed} passed   ${failed} failed`);
  if (failed === 0) console.log('All tests passed!');
  console.log('='.repeat(60));

  if (failed > 0) process.exit(1);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
