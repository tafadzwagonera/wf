import assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';

const DIST_MAIN = path.join(__dirname, '../../dist/main.js');

const runIssueCreate = (artifactPath: string): { status: number | null; output: string } => {
  const result = spawnSync(
    process.execPath,
    [DIST_MAIN, 'issue:create', artifactPath, '--tracker', 'jira', '--ticket-project', 'TEST'],
    {
      cwd: path.join(__dirname, '../..'),
      encoding: 'utf-8',
      stdio: 'pipe',
    }
  );

  return {
    status: result.status,
    output: `${result.stdout ?? ''}${result.stderr ?? ''}`,
  };
};

function main(): void {
  console.log('\nManual Test: issue:create live Jira validation gate\n');

  if (!fs.existsSync(DIST_MAIN)) {
    throw new Error('dist/main.js must exist before running this smoke test. Run `yarn build` first.');
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-issue-create-gate-'));
  const suspiciousArtifactPath = path.join(tmpDir, 'suspicious.md');
  const emptyArtifactPath = path.join(tmpDir, 'empty-after-strip.md');

  try {
    fs.writeFileSync(
      suspiciousArtifactPath,
      [
        '# Suspicious marker ticket',
        '',
        '**Type:** story',
        '**Priority:** medium',
        '',
        '## Description',
        'raw {code} marker found in text node',
      ].join('\n')
    );
    fs.writeFileSync(
      emptyArtifactPath,
      [
        '# Empty after strip',
        '',
        '**Type:** story',
        '**Priority:** medium',
        '',
        '## Description',
        '### Unit Test Scope',
        '- DTO validation covers required fields.',
        '',
        '#### Dependencies',
        '- service-auth v2',
        '',
        '### Affected Repositories',
        '- service-document-v1',
        '',
        '#### References',
        '- https://example.com/doc',
      ].join('\n')
    );

    const suspicious = runIssueCreate(suspiciousArtifactPath);
    assert.notStrictEqual(suspicious.status, 0, 'suspicious Jira artifact should fail before create');
    assert(
      suspicious.output.includes('Jira payload formatting check failed: raw {code} marker found in text node'),
      `unexpected suspicious-artifact output:\n${suspicious.output}`
    );
    console.log('  PASS: suspicious Jira payload is rejected before create');

    const empty = runIssueCreate(emptyArtifactPath);
    assert.notStrictEqual(empty.status, 0, 'empty-after-strip artifact should fail before create');
    assert(
      empty.output.includes('Ticket description is empty after removing internal-only sections.'),
      `unexpected empty-artifact output:\n${empty.output}`
    );
    console.log('  PASS: empty Jira description is rejected before create');

    console.log('\nAll issue:create validation gate smoke checks passed.\n');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

main();
