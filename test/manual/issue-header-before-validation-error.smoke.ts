/**
 * Manual Test: issue's runtime header prints before the --session-id/plan-token conflict error
 *
 * Run: nr test:manual issue-header-before-validation-error.smoke.ts
 *
 * Verifies that:
 *   1. `printCommandHeader('issue')` is called inside `validateAndResolveInputs`,
 *      synchronously before the mutually-exclusive --session-id/plan-token check,
 *      so the header still prints even though the command then fails
 *   2. The process exits non-zero when --session-id is combined with a plan token
 *   3. The ValidationError message still fires with its expected text
 *   4. `--silent` suppresses the header but the same ValidationError still fires
 *
 * This guards against a future refactor moving the printCommandHeader call out
 * of validateAndResolveInputs and into run()'s try block, which would silently
 * reverse this ordering — a change no existing unit test would catch, since
 * unit tests assert on printed content, not on whether printing happened
 * before a synchronous throw.
 *
 * No AI / API keys required — the conflict is rejected before any I/O.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createReporter, summarise } from './support/reporter';

const DIST_MAIN = path.join(__dirname, '../../dist/main.js');
const conflictingArgs = ['issue', 'some-plan.json', '--session-id', '550e8400-e29b-41d4-a716-446655440000'];

const { counts, pass, fail } = createReporter();

type CliResult = { stdout: string; stderr: string; status: number };

function runCli(args: string[], cwd: string): CliResult {
  try {
    const stdout = execFileSync('node', [DIST_MAIN, ...args], { encoding: 'utf-8', cwd });
    return { stdout, stderr: '', status: 0 };
  } catch (err: any) {
    return { stdout: err.stdout ?? '', stderr: err.stderr ?? '', status: err.status ?? 1 };
  }
}

function checkNonZeroExit(status: number): void {
  if (status === 0) fail('Expected a non-zero exit code', String(status));
  else pass('Process exits non-zero on the --session-id/plan-token conflict');
}

function checkSummaryLine(stdout: string): void {
  if (stdout.includes('Complete workflow: fetch, plan, implement, review, and commit.')) {
    pass('stdout contains the issue command summary line');
  } else {
    fail('Missing summary line in stdout', stdout.slice(0, 300));
  }
}

function checkValidationError(combined: string): void {
  if (combined.includes('Provide either --session-id or a plan token, not both')) {
    pass('The mutually-exclusive ValidationError message still fires');
  } else {
    fail('Missing expected ValidationError text', combined.slice(0, 300));
  }
}

function checkSilentSuppressesHeader(stdout: string): void {
  if (stdout.includes('Complete workflow: fetch, plan, implement, review, and commit.')) {
    fail('--silent did not suppress the header', stdout.slice(0, 300));
  } else {
    pass('--silent suppresses the header');
  }
}

function checkSilentValidationError(combined: string, status: number): void {
  if (combined.includes('Provide either --session-id or a plan token, not both') && status !== 0) {
    pass('--silent still surfaces the same ValidationError with non-zero exit');
  } else {
    fail('--silent changed the validation outcome', combined.slice(0, 300));
  }
}

function runAllChecks(scratchDir: string): void {
  const result = runCli(conflictingArgs, scratchDir);
  const silentResult = runCli([...conflictingArgs, '--silent'], scratchDir);
  checkNonZeroExit(result.status);
  checkSummaryLine(result.stdout);
  checkValidationError(result.stdout + result.stderr);
  checkSilentSuppressesHeader(silentResult.stdout);
  checkSilentValidationError(silentResult.stdout + silentResult.stderr, silentResult.status);
}

async function main(): Promise<void> {
  console.log('\n issue: header prints before the ValidationError\n');
  const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-issue-header-order-'));
  try {
    runAllChecks(scratchDir);
  } finally {
    fs.rmSync(scratchDir, { recursive: true, force: true });
  }
  summarise(counts);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
