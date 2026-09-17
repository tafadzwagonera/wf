/**
 * Manual Test: issue:generate:lookup --silent suppresses its new runtime header
 *
 * Run: nr test:manual -- test-issue-generate-lookup-silent-header
 *
 * Verifies that:
 *   1. `wf issue:generate:lookup <token>` prints the command summary line
 *   2. It also prints an "Examples:" heading with a wf issue:generate:lookup example
 *   3. `--silent` suppresses both the summary and the Examples: section
 *   4. `--silent` still surfaces the command's own error output (silencing the
 *      header must not silence the result)
 *
 * No AI / API keys required — a nonexistent artifact directory causes a fast,
 * expected failure while the header still prints ahead of it.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createReporter } from './support/reporter';

const DIST_MAIN = path.join(__dirname, '../../dist/main.js');

const { counts, pass, fail } = createReporter();

function runCli(args: string[], cwd: string): string {
  try {
    return execFileSync('node', [DIST_MAIN, ...args], { encoding: 'utf-8', cwd });
  } catch (err: any) {
    return (err.stdout ?? '') + (err.stderr ?? '');
  }
}

async function main(): Promise<void> {
  console.log('\n issue:generate:lookup --silent header\n');

  const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-generate-lookup-header-'));

  try {
    const withHeader = runCli(['issue:generate:lookup', '1a2b3c4d'], scratchDir);

    if (withHeader.includes('Lookup the original source list for a generated ticket artifact hash.')) {
      pass('Prints the issue:generate:lookup summary line');
    } else {
      fail('Missing summary line', withHeader.slice(0, 300));
    }

    if (/Examples:/.test(withHeader) && /wf issue:generate:lookup/.test(withHeader)) {
      pass('Prints an Examples: heading with a wf issue:generate:lookup example');
    } else {
      fail('Missing Examples: section', withHeader.slice(0, 300));
    }

    const silent = runCli(['issue:generate:lookup', '1a2b3c4d', '--silent'], scratchDir);

    if (silent.includes('Lookup the original source list') || silent.includes('Examples:')) {
      fail('--silent did not suppress the header', silent.slice(0, 300));
    } else {
      pass('--silent suppresses the summary and Examples: section');
    }

    if (silent.includes('No generated artifacts found under')) {
      pass('--silent still surfaces the underlying command error');
    } else {
      fail('--silent unexpectedly swallowed the command result', silent.slice(0, 300));
    }
  } finally {
    fs.rmSync(scratchDir, { recursive: true, force: true });
  }

  console.log('\n' + '='.repeat(60));
  console.log(`Results: ${counts.passed} passed   ${counts.failed} failed`);
  if (counts.failed === 0) console.log('All tests passed!');
  console.log('='.repeat(60));

  if (counts.failed > 0) process.exit(1);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
