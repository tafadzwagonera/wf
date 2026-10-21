/**
 * Manual smoke test: verification scripts skip when binary is missing from PATH.
 *
 * Run: nr test:manual verification-binary-check.smoke.ts
 *
 * Verifies:
 *   1. runProgrammaticVerification returns 'skipped' status when binary does not exist
 *   2. Skipped outcomes include the binary name in the output message
 *   3. runProgrammaticVerification runs normally when binary exists (e.g., echo, true)
 *   4. CD prefix handling correctly extracts the binary name for the existence check
 *   5. Ambiguous leading tokens (env assignments, subshells) are not probed
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { runProgrammaticVerification } from '../../src/integrations/ai/adapters/verification-report';
import type { VerificationScript } from '../../src/common/types/agent.types';
import { createReporter } from './support/reporter';

const { counts, pass, fail } = createReporter();
const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-binary-check-'));

const createScript = (id: string, command: string): VerificationScript[] => [
  { id, name: id, command, policy: 'enforced', aliases: [] },
];

const test1 = async (): Promise<void> => {
  console.log('Test 1: Missing binary results in skipped status');
  const outcomes = await runProgrammaticVerification(createScript('missing', 'nonexistent-binary-12345-abcdef plan'), repoDir);
  if (outcomes.length === 1 && outcomes[0].status === 'skipped') {
    pass('Missing binary results in skipped status');
  } else {
    fail(`Expected skipped status, got ${outcomes[0]?.status}`);
  }
};

const test2 = async (): Promise<void> => {
  console.log('Test 2: Skipped outcome includes binary name in output');
  const outcomes = await runProgrammaticVerification(createScript('missing', 'nonexistent-binary-12345-abcdef plan'), repoDir);
  if (outcomes[0]?.output?.includes('nonexistent-binary-12345-abcdef')) {
    pass('Skipped outcome includes binary name in message');
  } else {
    fail(`Expected binary name in output, got "${outcomes[0]?.output}"`);
  }
};

const test3 = async (): Promise<void> => {
  console.log('Test 3: Existing binary script runs normally');
  const outcomes = await runProgrammaticVerification(createScript('echo', 'echo "test"'), repoDir);
  if (outcomes.length === 1 && outcomes[0].status === 'passed') {
    pass('Existing binary script runs and reports passed');
  } else {
    fail(`Expected passed status, got ${outcomes[0]?.status}`);
  }
};

const test4 = async (): Promise<void> => {
  console.log('Test 4: CD prefix handling extracts binary correctly');
  const outcomes = await runProgrammaticVerification(createScript('cd-missing', 'cd /tmp && nonexistent-binary-12345-abcdef plan'), repoDir);
  if (outcomes[0]?.status === 'skipped' && outcomes[0]?.output?.includes('nonexistent-binary-12345-abcdef')) {
    pass('CD prefix correctly extracts binary for existence check');
  } else {
    fail(`Expected skipped with binary name in output, got status=${outcomes[0]?.status}, output="${outcomes[0]?.output}"`);
  }
};

const test5 = async (): Promise<void> => {
  console.log('Test 5: Ambiguous leading token does not skip binary check');
  const outcomes = await runProgrammaticVerification(createScript('env-assign', 'MYVAR=value echo "test"'), repoDir);
  if (outcomes[0]?.status === 'passed') {
    pass('Ambiguous leading token (env assignment) runs real command');
  } else {
    fail(`Expected passed status for env assignment, got ${outcomes[0]?.status}`);
  }
};

const cleanup = (): void => {
  try {
    execFileSync('rm', ['-rf', repoDir], { stdio: 'ignore' });
  } catch {
    // ignore cleanup errors
  }
};

const runTests = async (): Promise<void> => {
  console.log('\n=== Test: Verification binary existence check ===\n');
  try {
    for (const test of [test1, test2, test3, test4, test5]) await test();
  } catch (error) {
    console.error('Test error:', error);
    counts.failed++;
  } finally {
    cleanup();
    console.log(`\n--- Results: ${counts.passed} passed, ${counts.failed} failed ---\n`);
    process.exit(counts.failed > 0 ? 1 : 0);
  }
};

runTests().catch(error => {
  console.error(error);
  process.exit(1);
});
