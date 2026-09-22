/**
 * Manual Test: plan-artifact resolver matches by exact identifier, not prefix
 *
 * Run: nr test:manual plan-artifact-exact-match-resolves-prefix-collision.smoke.ts
 *
 * Reproduces the reported production bug: two custom plan artifacts whose
 * sourceName values are prefix/suffix pairs ('range-rename' and
 * 'range-rename-implementation-plan'). Before the fix, resolving the shorter
 * identifier threw "Multiple plan artifacts found" because prefix matching
 * treated the longer name as an alias for the shorter one. After the fix,
 * `wf issue:implement <shorter-name> --dry-run` must resolve only the exact
 * match, and the longer identifier must independently resolve to its own
 * artifact.
 *
 * No AI / API keys required — --dry-run exits before any provider call.
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
import { createReporter, summarise } from './support/reporter';

const DIST_MAIN = path.join(__dirname, '../../dist/main.js');

const { counts, pass, fail } = createReporter();

function runCli(args: string[], cwd: string, wfHome: string): string {
  try {
    return execFileSync('node', [DIST_MAIN, ...args], {
      encoding: 'utf-8',
      cwd,
      env: { ...process.env, WF_HOME: wfHome },
    });
  } catch (err: any) {
    return (err.stdout ?? '') + (err.stderr ?? '');
  }
}

function createPrefixCollisionFixtures(wfHomeDir: string, repoDir: string): { hashShort: string; hashLong: string } {
  const trackerDir = path.join(wfHomeDir, path.basename(repoDir), 'jira');
  fs.mkdirSync(trackerDir, { recursive: true });
  const createdAt = new Date('2026-08-25T00:00:00.000Z');
  const hashShort = hashPlanArtifactSources(['range-rename']);
  const hashLong = hashPlanArtifactSources(['range-rename-implementation-plan']);
  const planPathShort = path.join(trackerDir, buildPlanArtifactFilename({ createdAt, hash: hashShort, action: 'fix', format: 'json' }));
  const planPathLong = path.join(trackerDir, buildPlanArtifactFilename({ createdAt, hash: hashLong, action: 'fix', format: 'json' }));
  fs.writeFileSync(planPathShort, JSON.stringify({ action: 'fix', summary: 'Short plan', steps: ['x'], estimatedComplexity: 'low' }));
  fs.writeFileSync(planPathLong, JSON.stringify({ action: 'fix', summary: 'Long plan', steps: ['x'], estimatedComplexity: 'low' }));
  writePlanArtifactManifest(buildPlanArtifactManifest({ artifactPath: planPathShort, action: 'fix', format: 'json', hash: hashShort, sourceName: 'range-rename', sourceKind: 'custom', createdAt }));
  writePlanArtifactManifest(buildPlanArtifactManifest({ artifactPath: planPathLong, action: 'fix', format: 'json', hash: hashLong, sourceName: 'range-rename-implementation-plan', sourceKind: 'custom', createdAt }));
  return { hashShort, hashLong };
}

function checkShortNameResolution(repoDir: string, wfHomeDir: string, hashShort: string): void {
  const shortOutput = runCli(['issue:implement', 'range-rename', '--dry-run'], repoDir, wfHomeDir);
  if (shortOutput.includes(`${hashShort}-fix-plan.json`) && shortOutput.includes('custom plan range-rename')) pass('Shorter identifier resolves to the shorter-named artifact');
  else fail('Shorter identifier did not resolve to the expected artifact', shortOutput.slice(0, 500));
  if (shortOutput.includes('Multiple plan artifacts found')) fail('Shorter identifier incorrectly threw an ambiguity error', shortOutput.slice(0, 500));
  else pass('Shorter identifier does not throw "Multiple plan artifacts found"');
}

function checkLongNameResolution(repoDir: string, wfHomeDir: string, hashLong: string): void {
  const longOutput = runCli(['issue:implement', 'range-rename-implementation-plan', '--dry-run'], repoDir, wfHomeDir);
  if (longOutput.includes(`${hashLong}-fix-plan.json`)) pass('Longer identifier independently resolves to its own artifact');
  else fail('Longer identifier did not resolve to the expected artifact', longOutput.slice(0, 500));
}

async function main(): Promise<void> {
  console.log('\n plan-artifact exact-match resolution (prefix-collision bug)\n');
  const wfHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-home-prefix-collision-'));
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-repo-prefix-collision-'));
  try {
    const { hashShort, hashLong } = createPrefixCollisionFixtures(wfHomeDir, repoDir);
    checkShortNameResolution(repoDir, wfHomeDir, hashShort);
    checkLongNameResolution(repoDir, wfHomeDir, hashLong);
  } finally {
    fs.rmSync(wfHomeDir, { recursive: true, force: true });
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
  summarise(counts);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
