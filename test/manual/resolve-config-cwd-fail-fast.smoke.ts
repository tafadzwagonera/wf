/**
 * Manual smoke test: CLI exits with ConfigurationError when -r repo is unresolvable
 *
 * Run: nr test:manual resolve-config-cwd-fail-fast.smoke.ts
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

import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createReporter, summarise } from './support/reporter';

const DIST_MAIN = path.join(__dirname, '../../dist/main.js');

const { counts, pass, fail } = createReporter();

interface CliResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

function buildCliError(err: any): CliResult {
  return {
    exitCode: err.status ?? 1,
    stdout: err.stdout ?? '',
    stderr: err.stderr ?? '',
  };
}

const runCli = (args: string, cwd: string, reposDir: string): CliResult => {
  try {
    const stdout = execSync(`node ${DIST_MAIN} ${args}`, {
      encoding: 'utf-8',
      cwd,
      env: { ...process.env, WF_REPOS_DIR: reposDir },
      timeout: 15_000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { exitCode: 0, stdout, stderr: '' };
  } catch (err: any) {
    return buildCliError(err);
  }
};

function checkCaseAExitAndMessage(result: CliResult): void {
  if (result.exitCode === 0) {
    fail('Case A: expected non-zero exit code', `got ${result.exitCode}`);
  } else {
    pass('Case A: exits with non-zero code');
  }
  if (result.stderr.includes("Repository 'nonexistent-repo' not found")) {
    pass('Case A: stderr contains "not found" message');
  } else {
    fail('Case A: stderr missing "not found" message', result.stderr.slice(0, 300));
  }
}

function checkCaseASearchedPaths(result: CliResult, tempRoot: string): void {
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
}

function checkCaseAGuidance(result: CliResult): void {
  const guidance
    = 'Use an absolute path, run from a parent/sibling directory, '
      + 'or set WF_REPOS_DIR to the directory containing your repositories.';
  if (result.stderr.includes(guidance)) {
    pass('Case A: stderr includes actionable guidance');
  } else {
    fail('Case A: stderr missing guidance line');
  }
}

function checkCaseA(result: CliResult, tempRoot: string): void {
  checkCaseAExitAndMessage(result);
  checkCaseASearchedPaths(result, tempRoot);
  checkCaseAGuidance(result);
}

function checkCaseB(result: CliResult): void {
  if (result.exitCode === 0) {
    fail('Case B: expected non-zero exit code for --repos= form', `got ${result.exitCode}`);
  } else {
    pass('Case B: --repos= inline form exits with non-zero code');
  }
  if (result.stderr.includes("Repository 'nonexistent-repo' not found")) {
    pass('Case B: --repos= inline form stderr contains "not found" message');
  } else {
    fail('Case B: --repos= inline form missing error', result.stderr.slice(0, 300));
  }
}

function main(): void {
  console.log('\nManual smoke test: resolve-config-cwd fail-fast on unresolvable -r repo\n');
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-fail-fast-'));
  const emptyReposDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-fail-fast-repos-'));
  try {
    checkCaseA(runCli('issue:plan FAKE-123 -r nonexistent-repo', tempRoot, emptyReposDir), tempRoot);
    checkCaseB(runCli('issue:plan FAKE-123 --repos=nonexistent-repo', tempRoot, emptyReposDir));
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
    fs.rmSync(emptyReposDir, { recursive: true, force: true });
  }
  summarise(counts);
}

main();
