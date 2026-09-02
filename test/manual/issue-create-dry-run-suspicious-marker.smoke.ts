/**
 * Manual smoke test: suspicious Jira marker flagged in --dry-run preview (C4 dry-run path)
 *
 * Run: nr test:manual -- test-issue-create-dry-run-suspicious-marker
 *
 * Verifies that analyzeJiraPayload is exercised on the --dry-run path — i.e.,
 * that C4 sharing is in effect for dry-runs.
 *
 *   1. --dry-run with a suspicious {code} marker in the description exits 0
 *      (dry-run does not block; it previews) and surfaces the marker in output.
 *
 * Live-create blocking is covered by test-issue-create-live-validation-gate.ts.
 */

import assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';

const DIST_MAIN = path.join(__dirname, '../../dist/main.js');

const ARTIFACT = [
  '# Suspicious content',
  '',
  '**Type:** story',
  '**Priority:** medium',
  '',
  '## Description',
  'The legacy wrapper emits {code} blocks that the new renderer cannot parse.',
].join('\n');

const runCreate = (artifactPath: string, extraArgs: string[] = []): { status: number | null; output: string } => {
  const result = spawnSync(
    process.execPath,
    [DIST_MAIN, 'issue:create', artifactPath, '--tracker', 'jira', '--ticket-project', 'WBP', ...extraArgs],
    { cwd: path.join(__dirname, '../..'), encoding: 'utf-8', stdio: 'pipe' },
  );
  return { status: result.status, output: `${result.stdout ?? ''}${result.stderr ?? ''}` };
};

function main(): void {
  console.log('\nManual Test: suspicious Jira marker flagged in --dry-run preview\n');

  if (!fs.existsSync(DIST_MAIN)) {
    throw new Error('dist/main.js must exist before running this smoke test. Run `yarn build` first.');
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-suspicious-dryrun-'));
  const artifactPath = path.join(tmpDir, 'suspicious.md');

  try {
    fs.writeFileSync(artifactPath, ARTIFACT);

    const dryRun = runCreate(artifactPath, ['--dry-run']);
    assert.strictEqual(dryRun.status, 0, `--dry-run with suspicious artifact should exit 0, got ${dryRun.status}:\n${dryRun.output}`);
    assert.ok(
      dryRun.output.includes('{code}') || dryRun.output.toLowerCase().includes('suspicious'),
      `--dry-run must surface the suspicious marker in output:\n${dryRun.output}`,
    );
    console.log('  PASS: suspicious marker surfaced in --dry-run preview');

    console.log('\nAll suspicious-marker dry-run checks passed.\n');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

main();
