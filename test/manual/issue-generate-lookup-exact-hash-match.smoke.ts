/**
 * Manual Test: issue:generate:lookup matches the full stored hash only
 *
 * Run: nr test:manual -- test-issue-generate-lookup-exact-hash-match
 *
 * A generated-ticket source manifest exists on disk with a known 8-char hash
 * and an artifact filename containing an unrelated but matchable word
 * fragment. `wf issue:generate:lookup` must resolve on the full hash
 * (case-insensitive) and must NOT resolve on a truncated hash or a filename
 * substring — closing the loose-matching affordance removed from
 * findMatchingManifests.
 *
 * No AI / API keys required — lookup only reads local *.sources.json files.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createReporter } from './support/reporter';

const DIST_MAIN = path.join(__dirname, '../../dist/main.js');
const HASH = '1a2b3c4d';

const { counts, pass, fail } = createReporter();

function runCli(args: string[], cwd: string, wfHome: string): { output: string; exitCode: number } {
  try {
    const output = execFileSync('node', [DIST_MAIN, ...args], {
      encoding: 'utf-8',
      cwd,
      env: { ...process.env, WF_HOME: wfHome },
    });
    return { output, exitCode: 0 };
  } catch (err: any) {
    return { output: (err.stdout ?? '') + (err.stderr ?? ''), exitCode: err.status ?? 1 };
  }
}

async function main(): Promise<void> {
  console.log('\n issue:generate:lookup exact hash matching\n');

  const wfHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-home-lookup-hash-'));
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-repo-lookup-hash-'));
  const trackerDir = path.join(wfHomeDir, path.basename(repoDir), 'jira');

  try {
    fs.mkdirSync(trackerDir, { recursive: true });

    const artifactPath = path.join(trackerDir, `2026-04-16-${HASH}-range-rename.md`);
    const manifestPath = path.join(trackerDir, `2026-04-16-${HASH}-range-rename.sources.json`);
    fs.writeFileSync(artifactPath, '# range-rename\n\nGenerated ticket content.');
    fs.writeFileSync(
      manifestPath,
      JSON.stringify({
        artifactPath,
        createdAt: '2026-04-16T00:00:00.000Z',
        hash: HASH,
        sources: ['https://example.com/range-rename-spec'],
      })
    );

    const fullHash = runCli(['issue:generate:lookup', HASH], repoDir, wfHomeDir);
    if (fullHash.exitCode === 0 && fullHash.output.includes('https://example.com/range-rename-spec')) {
      pass('Full hash resolves and prints the stored sources');
    } else {
      fail('Full hash did not resolve', fullHash.output.slice(0, 500));
    }

    const upperHash = runCli(['issue:generate:lookup', HASH.toUpperCase()], repoDir, wfHomeDir);
    if (upperHash.exitCode === 0 && upperHash.output.includes('https://example.com/range-rename-spec')) {
      pass('Uppercase full hash also resolves');
    } else {
      fail('Uppercase full hash did not resolve', upperHash.output.slice(0, 500));
    }

    const truncatedHash = runCli(['issue:generate:lookup', HASH.slice(0, 4)], repoDir, wfHomeDir);
    if (truncatedHash.exitCode !== 0 && truncatedHash.output.includes('No generated ticket source manifest found')) {
      pass('Truncated hash no longer resolves (no-match FileSystemError)');
    } else {
      fail('Truncated hash unexpectedly resolved', truncatedHash.output.slice(0, 500));
    }

    const fragment = runCli(['issue:generate:lookup', 'range-rename'], repoDir, wfHomeDir);
    if (fragment.exitCode !== 0 && fragment.output.includes('No generated ticket source manifest found')) {
      pass('Filename fragment no longer resolves (no-match FileSystemError)');
    } else {
      fail('Filename fragment unexpectedly resolved', fragment.output.slice(0, 500));
    }
  } finally {
    fs.rmSync(wfHomeDir, { recursive: true, force: true });
    fs.rmSync(repoDir, { recursive: true, force: true });
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
