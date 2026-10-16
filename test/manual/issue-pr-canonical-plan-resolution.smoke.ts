/**
 * Manual Test: issue:pr resolves canonical plan artifacts via manifests
 *
 * Run: nr test:manual issue-pr-canonical-plan-resolution.smoke.ts
 *
 * issue:pr used to probe the legacy `<ticketKey>-plan-<action>.json` filename,
 * which the plan stage stopped writing when canonical
 * `YYYY-MM-DD-<hash>-<action>-plan.<ext>` naming landed — so every run failed
 * with "No plan artifact found" even when a plan existed. The command now
 * resolves plans through the shared manifest-based resolver.
 *
 * Scenario 1: no artifacts on disk — the command must still fail with the
 * actionable "No plan artifact found" guidance.
 * Scenario 2: a canonical plan + sidecar manifest exist — resolution must
 * succeed, proven by the PR header reaching the resolved plan's summary. The
 * run may still exit non-zero later (no GitHub credentials in this
 * environment), which is downstream of the resolution under test.
 *
 * No AI / API keys required — both checks complete before any provider call.
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
const TICKET_KEY = 'WBP-1';
const PLAN_SUMMARY = 'Fix the login bug';

const { counts, pass, fail } = createReporter();

function runCli(args: string[], cwd: string, wfHome: string): { output: string; exitCode: number } {
  try {
    const output = execFileSync('node', [DIST_MAIN, ...args], {
      encoding: 'utf-8',
      cwd,
      env: { ...process.env, WF_HOME: wfHome },
      timeout: 60_000,
    });
    return { output, exitCode: 0 };
  } catch (err: any) {
    return { output: (err.stdout ?? '') + (err.stderr ?? ''), exitCode: err.status ?? 1 };
  }
}

function writeCanonicalPlanFile(trackerDir: string, hash: string, createdAt: Date): string {
  fs.mkdirSync(trackerDir, { recursive: true });
  const planPath = path.join(trackerDir, buildPlanArtifactFilename({ createdAt, hash, action: 'fix', format: 'json' }));
  fs.writeFileSync(
    planPath,
    JSON.stringify({ action: 'fix', summary: PLAN_SUMMARY, steps: ['Patch it'], estimatedComplexity: 'low' })
  );
  return planPath;
}

function createCanonicalPlanArtifact(trackerDir: string): void {
  const hash = hashPlanArtifactSources([TICKET_KEY]);
  const createdAt = new Date('2026-10-16T00:00:00.000Z');
  const planPath = writeCanonicalPlanFile(trackerDir, hash, createdAt);
  writePlanArtifactManifest(
    buildPlanArtifactManifest({
      artifactPath: planPath, action: 'fix', format: 'json', hash,
      sourceName: TICKET_KEY, sourceKind: 'ticket', trackerName: 'github', createdAt,
    })
  );
}

function checkMissingPlanStillGuides(repoDir: string, wfHomeDir: string): void {
  const { output, exitCode } = runCli(['issue:pr', TICKET_KEY, '--tracker', 'github'], repoDir, wfHomeDir);
  if (exitCode === 0) {
    fail('CLI unexpectedly exited 0 with no plan artifact on disk', output.slice(0, 500));
    return;
  }
  if (output.includes(`No plan artifact found for ticket '${TICKET_KEY}'`) && output.includes('wf issue:plan')) {
    pass('Missing plan still fails with the actionable issue:plan guidance');
  } else {
    fail('Missing-plan error lost its "No plan artifact found" guidance', output.slice(0, 500));
  }
}

function checkCanonicalPlanResolves(repoDir: string, wfHomeDir: string): void {
  const { output } = runCli(['issue:pr', TICKET_KEY, '--tracker', 'github'], repoDir, wfHomeDir);
  if (output.includes('No plan artifact found')) {
    fail('Canonical plan artifact was not resolved (legacy-filename probe regression)', output.slice(0, 500));
    return;
  }
  pass('Canonical YYYY-MM-DD-<hash>-<action>-plan.json resolves via its manifest');
  if (output.includes(PLAN_SUMMARY)) {
    pass('Resolved plan summary reached PR parameter construction');
  } else {
    fail('PR header never echoed the resolved plan summary', output.slice(0, 500));
  }
}

async function main(): Promise<void> {
  console.log('\n issue:pr canonical plan artifact resolution\n');
  const wfHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-home-issue-pr-'));
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-repo-issue-pr-'));
  const trackerDir = path.join(wfHomeDir, path.basename(repoDir), 'github');
  try {
    checkMissingPlanStillGuides(repoDir, wfHomeDir);
    createCanonicalPlanArtifact(trackerDir);
    checkCanonicalPlanResolves(repoDir, wfHomeDir);
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
