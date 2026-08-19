/**
 * Manual Test: issue's runtime header prints before the --session-id/plan-token conflict error
 *
 * Run: nr test:manual -- test-issue-header-before-validation-error
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

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';

const DIST_MAIN = path.join(__dirname, '../../dist/main.js');
const CONFLICTING_ARGS = ['issue', 'some-plan.json', '--session-id', '550e8400-e29b-41d4-a716-446655440000'];

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

function runCli(args: string[], cwd: string): { stdout: string; stderr: string; status: number } {
  try {
    const stdout = execFileSync('node', [DIST_MAIN, ...args], { encoding: 'utf-8', cwd });
    return { stdout, stderr: '', status: 0 };
  } catch (err: any) {
    return { stdout: err.stdout ?? '', stderr: err.stderr ?? '', status: err.status ?? 1 };
  }
}

async function main() {
  console.log('\n issue: header prints before the ValidationError\n');

  const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-issue-header-order-'));

  try {
    const result = runCli(CONFLICTING_ARGS, scratchDir);
    const combined = result.stdout + result.stderr;

    if (result.status !== 0) {
      pass('Process exits non-zero on the --session-id/plan-token conflict');
    } else {
      fail('Expected a non-zero exit code', String(result.status));
    }

    if (result.stdout.includes('Complete workflow: fetch, plan, implement, review, and commit.')) {
      pass('stdout contains the issue command summary line');
    } else {
      fail('Missing summary line in stdout', result.stdout.slice(0, 300));
    }

    if (combined.includes('Provide either --session-id or a plan token, not both')) {
      pass('The mutually-exclusive ValidationError message still fires');
    } else {
      fail('Missing expected ValidationError text', combined.slice(0, 300));
    }

    const silentResult = runCli([...CONFLICTING_ARGS, '--silent'], scratchDir);
    const silentCombined = silentResult.stdout + silentResult.stderr;

    if (!silentResult.stdout.includes('Complete workflow: fetch, plan, implement, review, and commit.')) {
      pass('--silent suppresses the header');
    } else {
      fail('--silent did not suppress the header', silentResult.stdout.slice(0, 300));
    }

    if (silentCombined.includes('Provide either --session-id or a plan token, not both') && silentResult.status !== 0) {
      pass('--silent still surfaces the same ValidationError with non-zero exit');
    } else {
      fail('--silent changed the validation outcome', silentCombined.slice(0, 300));
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
