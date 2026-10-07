/**
 * Manual smoke test: a genuinely custom plan (no ticketKey/customArtifactName)
 * resolves its session by sourceName, and that session wins over the
 * manifest's own sourceBranch field
 *
 * Verifies:
 *   1. A custom-plan manifest with only a sourceName (no ticketKey, no
 *      customArtifactName) is found by branch name.
 *   2. Its session lookup key falls all the way to `sourceName`, and
 *      SessionService.findByTicketKey('my-custom-plan') — a real, on-disk
 *      session — is what actually resolves.
 *   3. That session's sourceBranch (release/2026) wins over the manifest's own,
 *      deliberately different, sourceBranch field (develop).
 *   4. git reflog is never reached, since the session hit short-circuits first.
 *
 * Run: nr test:manual sonar-custom-plan-session-lookup.smoke.ts
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { NestFactory } from '@nestjs/core';
import chalk from 'chalk';
import { AppModule } from '../../src/app.module';
import { SonarStageService } from '../../src/review/sonar-stage.service';
import { SessionService } from '../../src/shared/session/session.service';
import * as sonarScannerModule from '../../src/review/sonar-scanner';
import { buildPlanArtifactManifest, writePlanArtifactManifest } from '../../src/shared/utils/plan-artifact';
import { resolveCustomArtifactDir } from '../../src/agents/utils';

import { createReporter, summarise } from './support/reporter';
import { restoreEnv, withEnv } from '../../src/shared/testing/env';

const { counts, pass, fail } = createReporter();

const git = (dir: string, args: string[]): string =>
  execFileSync('git', args, { cwd: dir, encoding: 'utf-8' }).trim();

function initGitRepo(repoDir: string): void {
  git(repoDir, ['init', '-q', '-b', 'master']);
  git(repoDir, ['config', 'user.email', 'test@example.com']);
  git(repoDir, ['config', 'user.name', 'Test']);
}

function commitFileChange(repoDir: string, content: string, message: string): void {
  fs.appendFileSync(path.join(repoDir, 'a.txt'), content);
  git(repoDir, ['commit', '-q', '-am', message]);
}

function setupTestRepo(repoDir: string): void {
  initGitRepo(repoDir);
  fs.writeFileSync(path.join(repoDir, 'a.txt'), 'base\n');
  git(repoDir, ['add', 'a.txt']);
  git(repoDir, ['commit', '-q', '-m', 'base']);
  git(repoDir, ['checkout', '-q', '-b', 'develop']);
  commitFileChange(repoDir, 'develop\n', 'develop work');
  git(repoDir, ['checkout', '-q', 'master']);
  git(repoDir, ['checkout', '-q', '-b', 'release/2026']);
  commitFileChange(repoDir, 'release\n', 'release work');
  git(repoDir, ['checkout', '-q', '-b', 'fix/my-custom-plan']);
  commitFileChange(repoDir, 'feature\n', 'feature work');
}

function checkTestSetupValidity(repoDir: string): { expectedReleaseMergeBase: string } {
  const expectedDevelopMergeBase = git(repoDir, ['merge-base', 'develop', 'fix/my-custom-plan']);
  const expectedReleaseMergeBase = git(repoDir, ['merge-base', 'release/2026', 'fix/my-custom-plan']);
  if (expectedReleaseMergeBase === expectedDevelopMergeBase) {
    fail('Test setup invalid: develop and release/2026 share a merge-base with fix/my-custom-plan — cannot distinguish');
  } else {
    pass('Test setup valid: develop and release/2026 have different merge-bases with fix/my-custom-plan');
  }
  return { expectedReleaseMergeBase };
}

function setupCustomPlanArtifact(repoDir: string): void {
  const customDir = resolveCustomArtifactDir(repoDir);
  fs.mkdirSync(customDir, { recursive: true });
  const artifactPath = path.join(customDir, '2026-08-25-abc123-fix-plan.json');
  fs.writeFileSync(artifactPath, JSON.stringify({ action: 'fix', summary: 'x', steps: [], estimatedComplexity: 'low' }));
  writePlanArtifactManifest({
    ...buildPlanArtifactManifest({ artifactPath, action: 'fix', format: 'json', hash: 'abc123', sourceName: 'my-custom-plan', sourceKind: 'custom', createdAt: new Date() }),
    sourceBranch: 'develop',
    branchName: 'fix/my-custom-plan',
  });
}

async function checkSessionLookup(sessionService: SessionService): Promise<void> {
  const found = await sessionService.findByTicketKey('my-custom-plan');
  if (found?.sourceBranch === 'release/2026') {
    pass("findByTicketKey('my-custom-plan') found the real session with sourceBranch release/2026");
  } else {
    fail("Expected the session keyed by 'my-custom-plan'", JSON.stringify(found));
  }
}

function mockScannerForScopeCapture(capturedScopes: unknown[]): () => void {
  const originalRunSonarScan = sonarScannerModule.runSonarScan;
  (sonarScannerModule as unknown as Record<string, unknown>)['runSonarScan'] = async (opts: { scope: unknown }) => {
    capturedScopes.push(opts.scope);
    return { status: 'clean', steps: [] };
  };
  return (): void => {
    (sonarScannerModule as unknown as Record<string, unknown>)['runSonarScan'] = originalRunSonarScan;
  };
}

function setupScopeResolutionMocks(
  sonarStageService: SonarStageService,
  capturedScopes: unknown[],
): { reflogCallsRef: { count: number }; restoreScan: () => void } {
  const reflogCallsRef = { count: 0 };
  const restoreScan = mockScannerForScopeCapture(capturedScopes);
  (sonarStageService as any).gitService.getBranchCreationSource = async () => {
    reflogCallsRef.count++;
    return null;
  };
  return { reflogCallsRef, restoreScan };
}

function checkScopeResolution(capturedScopes: unknown[], expectedReleaseMergeBase: string): void {
  const expectedScope = { kind: 'base', ref: expectedReleaseMergeBase };
  if (JSON.stringify(capturedScopes.at(-1)) === JSON.stringify(expectedScope)) {
    pass(`Session's sourceBranch (release/2026) won over the manifest's own field (develop): ${expectedReleaseMergeBase}`);
  } else {
    fail('Expected the release/2026 merge-base sha (from the session, not the manifest)', `got: ${JSON.stringify(capturedScopes.at(-1))}`);
  }
}

function verifySessionResolution(
  reflogCallsRef: { count: number },
  capturedScopes: unknown[],
  expectedReleaseMergeBase: string,
): void {
  if (reflogCallsRef.count === 0) {
    pass('git reflog was never called — the session-by-sourceName lookup resolved it first');
  } else {
    fail('Expected git reflog not to be called when the sourceName session lookup resolves the source branch');
  }
  checkScopeResolution(capturedScopes, expectedReleaseMergeBase);
}

async function checkSonarScopeResolution(
  sonarStageService: SonarStageService,
  repoDir: string,
  expectedReleaseMergeBase: string,
): Promise<void> {
  const capturedScopes: unknown[] = [];
  const { reflogCallsRef, restoreScan } = setupScopeResolutionMocks(sonarStageService, capturedScopes);
  await sonarStageService.scanIfEnabled({ repoDir, force: true, allowPrompt: true, onProgress: () => {} });
  restoreScan();
  verifySessionResolution(reflogCallsRef, capturedScopes, expectedReleaseMergeBase);
}

function setupEnv(
  prefix: string,
  homePrefix: string,
): { repoDir: string; wfHome: string } {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const wfHome = fs.mkdtempSync(path.join(os.tmpdir(), homePrefix));
  withEnv({ WF_HOME: wfHome });
  return { repoDir, wfHome };
}

function cleanupEnv(repoDir: string, wfHome: string): void {
  fs.rmSync(repoDir, { recursive: true, force: true });
  fs.rmSync(wfHome, { recursive: true, force: true });
  restoreEnv();
}

function setupScenario(repoDir: string): { expectedReleaseMergeBase: string } {
  setupTestRepo(repoDir);
  const { expectedReleaseMergeBase } = checkTestSetupValidity(repoDir);
  setupCustomPlanArtifact(repoDir);
  return { expectedReleaseMergeBase };
}

async function saveCustomPlanSession(sessionService: SessionService): Promise<void> {
  await sessionService.save({
    sessionId: 'session-custom', ticketKey: 'my-custom-plan', toStage: 'commit', action: 'fix',
    sourceType: 'custom', customPlanRef: 'my-custom-plan.md', sourceBranch: 'release/2026',
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), completedAt: null, stages: {},
  } as any);
}

async function main(): Promise<void> {
  console.log('Manual smoke: custom-plan session lookup by sourceName\n');
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error'] });
  const sonarStageService = app.get(SonarStageService);
  const sessionService = app.get(SessionService);
  const { repoDir, wfHome } = setupEnv('sonar-custom-session-', 'sonar-custom-session-home-');
  const { expectedReleaseMergeBase } = setupScenario(repoDir);
  await saveCustomPlanSession(sessionService);
  await checkSessionLookup(sessionService);
  await checkSonarScopeResolution(sonarStageService, repoDir, expectedReleaseMergeBase);
  cleanupEnv(repoDir, wfHome);
  console.log(`\n${counts.passed} passed, ${counts.failed} failed`);
  await app.close();
  summarise(counts);
}

main().catch(error => {
  console.error(`\nManual smoke test failed: ${error.message}`);
  process.exit(1);
});
