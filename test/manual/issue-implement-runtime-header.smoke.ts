/**
 * Manual Test: issue:implement prints a runtime header where none existed before
 *
 * Run: nr test:manual issue-implement-runtime-header.smoke.ts
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

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createReporter, summarise } from './support/reporter';

const DIST_MAIN = path.join(__dirname, '../../dist/main.js');

const { counts, pass, fail } = createReporter();

function runCli(args: string[], cwd: string): string {
  try {
    return execFileSync('node', [DIST_MAIN, ...args], { encoding: 'utf-8', cwd });
  } catch (err: any) {
    return (err.stdout ?? '') + (err.stderr ?? '');
  }
}

function runScenario(scratchDir: string): { withHeader: string; silent: string } {
  const withHeader = runCli(['issue:implement', '--dry-run', '-k', 'WBP-1'], scratchDir);
  const silent = runCli(['issue:implement', '--dry-run', '-k', 'WBP-1', '--silent'], scratchDir);
  return { withHeader, silent };
}

function checkImplementSummaryLine(withHeader: string): void {
  if (withHeader.includes('Carry out an implementation plan from a ticket-backed, hashed, or custom plan artifact.')) {
    pass('Prints the issue:implement summary line');
  } else {
    fail('Missing summary line', withHeader.slice(0, 300));
  }
}

function checkImplementExamples(withHeader: string): void {
  if (/Examples:/.test(withHeader) && /wf issue:implement/.test(withHeader)) {
    pass('Prints an Examples: heading with a wf issue:implement example');
  } else {
    fail('Missing Examples: section', withHeader.slice(0, 300));
  }
}

function checkSilentSuppressesHeader(silent: string): void {
  if (!silent.includes('Carry out an implementation plan') && !silent.includes('Examples:')) {
    pass('--silent suppresses the summary and Examples: section');
  } else {
    fail('--silent did not suppress the header', silent.slice(0, 300));
  }
}

async function main(): Promise<void> {
  console.log('\n issue:implement runtime header\n');
  const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-implement-header-'));
  try {
    const { withHeader, silent } = runScenario(scratchDir);
    checkImplementSummaryLine(withHeader);
    checkImplementExamples(withHeader);
    checkSilentSuppressesHeader(silent);
  } finally {
    fs.rmSync(scratchDir, { recursive: true, force: true });
  }
  summarise(counts);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
