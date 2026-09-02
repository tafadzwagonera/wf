/**
 * Manual Test: genuine plan-artifact ambiguity surfaces as a typed error, not a guessed action
 *
 * Run: nr test:manual -- test-plan-artifact-ambiguous-duplicate-error
 *
 * Two manifests share the identical hash and sourceName but differ only by
 * date prefix — a genuine duplicate, not a prefix-collision false positive.
 * `wf issue:implement <name> --dry-run` must fail loudly with
 * AmbiguousPlanArtifactError's message before any dry-run preview output is
 * produced, proving the resolver no longer silently falls through to a
 * guessed action (the original swallow-site bug).
 *
 * No AI / API keys required — resolution fails before any provider call.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  buildPlanArtifactFilename,
  buildPlanArtifactManifest,
  writePlanArtifactManifest,
  hashPlanArtifactSources,
} from '../../src/shared/utils/plan-artifact';
import { createReporter } from './support/reporter';

const DIST_MAIN = path.join(__dirname, '../../dist/main.js');

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
  console.log('\n plan-artifact ambiguity surfaces as a typed error\n');

  const wfHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-home-ambiguous-'));
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-repo-ambiguous-'));
  const trackerDir = path.join(wfHomeDir, path.basename(repoDir), 'jira');

  try {
    fs.mkdirSync(trackerDir, { recursive: true });

    const hash = hashPlanArtifactSources(['test-dup']);
    const createdAt1 = new Date('2026-08-24T00:00:00.000Z');
    const createdAt2 = new Date('2026-08-25T00:00:00.000Z');

    const planPath1 = path.join(
      trackerDir,
      buildPlanArtifactFilename({ createdAt: createdAt1, hash, action: 'fix', format: 'json' })
    );
    const planPath2 = path.join(
      trackerDir,
      buildPlanArtifactFilename({ createdAt: createdAt2, hash, action: 'fix', format: 'json' })
    );

    fs.writeFileSync(planPath1, JSON.stringify({ action: 'fix', summary: 'Dup plan 1', steps: ['x'], estimatedComplexity: 'low' }));
    fs.writeFileSync(planPath2, JSON.stringify({ action: 'fix', summary: 'Dup plan 2', steps: ['x'], estimatedComplexity: 'low' }));

    writePlanArtifactManifest(
      buildPlanArtifactManifest({ artifactPath: planPath1, action: 'fix', format: 'json', hash: hash, sourceName: 'test-dup', sourceKind: 'custom', createdAt: createdAt1 })
    );
    writePlanArtifactManifest(
      buildPlanArtifactManifest({ artifactPath: planPath2, action: 'fix', format: 'json', hash: hash, sourceName: 'test-dup', sourceKind: 'custom', createdAt: createdAt2 })
    );

    const { output, exitCode } = runCli(['issue:implement', 'test-dup', '--dry-run'], repoDir, wfHomeDir);

    if (exitCode !== 0) {
      pass('CLI exits non-zero on genuine ambiguity');
    } else {
      fail('CLI unexpectedly exited 0', output.slice(0, 500));
    }

    if (output.includes("Multiple plan artifacts found for 'test-dup'")) {
      pass('Error message names the ambiguous identifier');
    } else {
      fail('Missing "Multiple plan artifacts found" message', output.slice(0, 500));
    }

    if (output.includes('Remove or regenerate the stale artifact.')) {
      pass('Error message carries the actionable remedy (not the old unreachable hashed-filename advice)');
    } else {
      fail('Missing the new actionable remedy text', output.slice(0, 500));
    }

    if (!output.includes('Detected plan artifact')) {
      pass('Resolution never fell through to a guessed/legacy action');
    } else {
      fail('Resolution incorrectly proceeded to a resolved artifact', output.slice(0, 500));
    }

    if (!output.includes('Dry Run')) {
      pass('No dry-run preview section was printed');
    } else {
      fail('Dry-run preview was printed despite the ambiguity', output.slice(0, 500));
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
