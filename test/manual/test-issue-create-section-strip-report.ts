/**
 * Manual smoke test: stripped-section names are reported in non-silent output
 * and ### Risks & Assumptions is preserved through the dry-run preview
 *
 * Run: nr test:manual -- test-issue-create-section-strip-report
 *
 * Verifies:
 *   1. Non-silent dry-run output contains "Removed internal-only sections:"
 *      listing the stripped headings.
 *   2. "Risks" does not appear in that stripped-sections line (it is preserved).
 *   3. The dry-run preview output contains "Risks & Assumptions" content,
 *      confirming the section survived stripping.
 *   4. Running with --silent suppresses the stripped-sections log line.
 *
 * No AI / API keys required — --dry-run never calls createTicket.
 */

import assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';

const DIST_MAIN = path.join(__dirname, '../../dist/main.js');

const ARTIFACT = [
  '# Auth token expiry not enforced',
  '',
  '**Type:** bug',
  '**Priority:** high',
  '',
  '## Description',
  'Token expiry is not validated on the /api/data route.',
  '',
  '### Risks & Assumptions',
  '- Rolling out without a migration plan risks locking out active users.',
  '- Assumes the auth middleware is the single validation point.',
  '',
  '### Unit Test Scope',
  '- Unit tests for the middleware validation logic only.',
  '',
  '#### Dependencies',
  '- auth-service v2',
].join('\n');

const run = (artifactPath: string, extraArgs: string[] = []): { status: number | null; output: string } => {
  const result = spawnSync(
    process.execPath,
    [DIST_MAIN, 'issue:create', artifactPath, '--dry-run', '--tracker', 'jira', '--ticket-project', 'WBP', ...extraArgs],
    { cwd: path.join(__dirname, '../..'), encoding: 'utf-8', stdio: 'pipe' },
  );
  return { status: result.status, output: `${result.stdout ?? ''}${result.stderr ?? ''}` };
};

const main = (): void => {
  console.log('\nManual Test: issue:create section strip report and Risks & Assumptions preservation\n');

  if (!fs.existsSync(DIST_MAIN)) {
    throw new Error('dist/main.js must exist before running this smoke test. Run `yarn build` first.');
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-section-strip-'));
  const artifactPath = path.join(tmpDir, 'artifact.md');

  try {
    fs.writeFileSync(artifactPath, ARTIFACT);

    const nonSilent = run(artifactPath);
    assert.strictEqual(nonSilent.status, 0, `non-silent dry-run should exit 0, got ${nonSilent.status}:\n${nonSilent.output}`);

    const strippedLine = nonSilent.output
      .split('\n')
      .find(l => l.includes('Removed internal-only sections:'));
    assert.ok(strippedLine, `expected "Removed internal-only sections:" in output:\n${nonSilent.output}`);
    assert.ok(
      !strippedLine.includes('Risks'),
      `"Risks" must not appear in stripped-sections line: ${strippedLine}`,
    );
    console.log('  PASS: stripped-sections line present and excludes Risks & Assumptions');

    assert.ok(
      nonSilent.output.includes('Risks') || nonSilent.output.includes('Rolling out without a migration plan'),
      `### Risks & Assumptions content must appear in dry-run preview:\n${nonSilent.output}`,
    );
    console.log('  PASS: ### Risks & Assumptions content present in dry-run preview');

    const silent = run(artifactPath, ['--silent']);
    assert.ok(
      !silent.output.includes('Removed internal-only sections:'),
      `--silent must suppress stripped-sections line:\n${silent.output}`,
    );
    console.log('  PASS: --silent suppresses stripped-sections report');

    console.log('\nAll section strip report checks passed.\n');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
};

main();
