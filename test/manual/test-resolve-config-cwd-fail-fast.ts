/**
 * Manual smoke test: CLI exits with ConfigurationError when -r repo is unresolvable
 *
 * Run: nr test:manual -- test-resolve-config-cwd-fail-fast
 *
 * Verifies that:
 *   1. `-r nonexistent-repo` from a temp dir exits 1 with "not found" message
 *   2. `--repos=nonexistent-repo` inline form produces the same error
 *   3. stderr includes both searched paths (CWD-relative and sibling)
 *   4. stderr includes the actionable guidance line
 *
 * Successful-resolution cases (bare --repos/-r form, no-flag fallback) are
 * covered more rigorously by test-repos-bare-form-resolves-target-config,
 * which asserts the actual config that gets loaded rather than just the
 * absence of a thrown error.
 */

import { execSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const DIST_MAIN = path.join(__dirname, '../../dist/main.js');

let passed = 0;
let failed = 0;

const pass = (msg: string): void => {
  console.log(`  pass: ${msg}`);
  passed++;
};

const fail = (msg: string, detail?: string): void => {
  console.error(`  FAIL: ${msg}${detail ? `\n    -> ${detail}` : ''}`);
  failed++;
};

interface CliResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

const runCli = (args: string, cwd: string): CliResult => {
  try {
    const stdout = execSync(`node ${DIST_MAIN} ${args}`, {
      encoding: 'utf-8',
      cwd,
      timeout: 15_000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { exitCode: 0, stdout, stderr: '' };
  } catch (err: any) {
    return {
      exitCode: err.status ?? 1,
      stdout: err.stdout ?? '',
      stderr: err.stderr ?? '',
    };
  }
};

console.log('\nManual smoke test: resolve-config-cwd fail-fast on unresolvable -r repo\n');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-fail-fast-'));

try {
  // Case A: -r nonexistent-repo from temp dir
  {
    const result = runCli('issue:plan FAKE-123 -r nonexistent-repo', tempRoot);

    if (result.exitCode !== 0) {
      pass('Case A: exits with non-zero code');
    } else {
      fail('Case A: expected non-zero exit code', `got ${result.exitCode}`);
    }

    if (result.stderr.includes("Repository 'nonexistent-repo' not found")) {
      pass('Case A: stderr contains "not found" message');
    } else {
      fail('Case A: stderr missing "not found" message', result.stderr.slice(0, 300));
    }

    const cwdRelative = path.resolve(tempRoot, 'nonexistent-repo');
    const siblingRelative = path.resolve(tempRoot, '..', 'nonexistent-repo');
    if (result.stderr.includes(cwdRelative)) {
      pass('Case A: stderr includes CWD-relative searched path');
    } else {
      fail('Case A: stderr missing CWD-relative path', `expected ${cwdRelative}`);
    }

    if (result.stderr.includes(siblingRelative)) {
      pass('Case A: stderr includes sibling searched path');
    } else {
      fail('Case A: stderr missing sibling path', `expected ${siblingRelative}`);
    }

    if (result.stderr.includes('Use an absolute path or run from a parent/sibling directory')) {
      pass('Case A: stderr includes actionable guidance');
    } else {
      fail('Case A: stderr missing guidance line');
    }
  }

  // Case B: --repos=nonexistent-repo inline form
  {
    const result = runCli('issue:plan FAKE-123 --repos=nonexistent-repo', tempRoot);

    if (result.exitCode !== 0) {
      pass('Case B: --repos= inline form exits with non-zero code');
    } else {
      fail('Case B: expected non-zero exit code for --repos= form', `got ${result.exitCode}`);
    }

    if (result.stderr.includes("Repository 'nonexistent-repo' not found")) {
      pass('Case B: --repos= inline form stderr contains "not found" message');
    } else {
      fail('Case B: --repos= inline form missing error', result.stderr.slice(0, 300));
    }
  }
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}

const separator = '\n' + '='.repeat(60);
console.log(separator);
console.log(`Results: ${passed} passed   ${failed} failed`);
if (failed === 0) {
  console.log('All tests passed!');
}
console.log('='.repeat(60));

if (failed > 0) process.exit(1);
