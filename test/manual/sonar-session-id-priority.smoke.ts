/**
 * Manual smoke test: --session-id (provider session ID) resolves the originating
 * session's sourceBranch, picking the most recent match among several on disk
 *
 * Verifies:
 *   1. SessionService.findByProviderSessionId (real, on-disk sessions) returns
 *      the most recently created session whose stages.plan.providerSessionId
 *      matches — not an older one with the same provider session id.
 *   2. resolveSonarOutputForTarget, given options.sessionId, never touches the
 *      plan-manifest lookup or git reflog.
 *   3. The merge-base scan uses that session's sourceBranch, against a real
 *      `git merge-base` computation.
 *
 * Run: nr test:manual sonar-session-id-priority.smoke.ts
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
import { createReporter, summarise } from './support/reporter';

const { counts, pass, fail } = createReporter();

const git = (dir: string, args: string[]): string =>
  execFileSync('git', args, { cwd: dir, encoding: 'utf-8' }).trim();

function setupWfEnvironment(
  prefix: string,
  homePrefix: string,
): { repoDir: string; wfHome: string; originalWfHome: string | undefined } {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const wfHome = fs.mkdtempSync(path.join(os.tmpdir(), homePrefix));
  const originalWfHome = process.env.WF_HOME;
  process.env.WF_HOME = wfHome;
  return { repoDir, wfHome, originalWfHome };
}

function cleanupWfEnvironment(repoDir: string, wfHome: string, originalWfHome: string | undefined): void {
  fs.rmSync(repoDir, { recursive: true, force: true });
  fs.rmSync(wfHome, { recursive: true, force: true });
  if (originalWfHome === undefined) delete process.env.WF_HOME;
  else process.env.WF_HOME = originalWfHome;
}

function initGitRepo(repoDir: string): void {
  git(repoDir, ['init', '-q', '-b', 'master']);
  git(repoDir, ['config', 'user.email', 'test@example.com']);
  git(repoDir, ['config', 'user.name', 'Test']);
}

function commitFileChange(repoDir: string, content: string, message: string): void {
  fs.appendFileSync(path.join(repoDir, 'a.txt'), content);
  git(repoDir, ['commit', '-q', '-am', message]);
}

function setupSessionPriorityRepo(repoDir: string): void {
  initGitRepo(repoDir);
  fs.writeFileSync(path.join(repoDir, 'a.txt'), 'base\n');
  git(repoDir, ['add', 'a.txt']);
  git(repoDir, ['commit', '-q', '-m', 'base']);
  git(repoDir, ['checkout', '-q', '-b', 'develop']);
  commitFileChange(repoDir, 'develop\n', 'develop work');
  git(repoDir, ['checkout', '-q', 'master']);
  git(repoDir, ['checkout', '-q', '-b', 'release/2026']);
  commitFileChange(repoDir, 'release\n', 'release work');
  git(repoDir, ['checkout', '-q', '-b', 'feature/WBP-1-thing']);
  commitFileChange(repoDir, 'feature\n', 'feature work');
}

function checkTestSetupValid(expectedReleaseMergeBase: string, expectedDevelopMergeBase: string): void {
  if (expectedReleaseMergeBase === expectedDevelopMergeBase) {
    fail('Test setup invalid: develop and release/2026 share a merge-base with the feature branch — cannot distinguish');
  } else {
    pass('Test setup valid: develop and release/2026 have different merge-bases with the feature branch');
  }
}

function makePlanStage(providerSessionId: string): object {
  return {
    config: { provider: 'anthropic', backend: 'agent' }, model: 'claude', modelsUsed: [],
    providerSessionId, summary: null, startedAt: new Date().toISOString(), completedAt: null,
  };
}

async function saveSessionPair(sessionService: SessionService): Promise<void> {
  await sessionService.save({
    sessionId: 'older-session', ticketKey: 'WBP-1', toStage: 'commit', action: 'fix', sourceType: 'ticket',
    customPlanRef: null, sourceBranch: 'develop', createdAt: new Date('2026-01-01T00:00:00.000Z').toISOString(),
    updatedAt: new Date().toISOString(), completedAt: null, stages: { plan: makePlanStage('provider-abc') },
  } as any);
  await sessionService.save({
    sessionId: 'newer-session', ticketKey: 'WBP-1', toStage: 'commit', action: 'fix', sourceType: 'ticket',
    customPlanRef: null, sourceBranch: 'release/2026', createdAt: new Date('2026-02-01T00:00:00.000Z').toISOString(),
    updatedAt: new Date().toISOString(), completedAt: null, stages: { plan: makePlanStage('provider-abc') },
  } as any);
}

async function setupSessionsAndCheckTest1(sessionService: SessionService): Promise<void> {
  console.log(chalk.bold.cyan('\nTest 1: findByProviderSessionId picks the most recent match'));
  await saveSessionPair(sessionService);
  const found = await sessionService.findByProviderSessionId('provider-abc', 'plan');
  if (found?.sessionId === 'newer-session' && found.sourceBranch === 'release/2026') {
    pass('findByProviderSessionId returned the newer session (release/2026), not the older one (develop)');
  } else {
    fail('Expected the newer session with sourceBranch release/2026', JSON.stringify(found));
  }
}

function computeAndValidateMergeBases(repoDir: string): { expectedReleaseMergeBase: string } {
  const expectedDevelopMergeBase = git(repoDir, ['merge-base', 'develop', 'feature/WBP-1-thing']);
  const expectedReleaseMergeBase = git(repoDir, ['merge-base', 'release/2026', 'feature/WBP-1-thing']);
  checkTestSetupValid(expectedReleaseMergeBase, expectedDevelopMergeBase);
  return { expectedReleaseMergeBase };
}

async function runAndCheckTest2Bypass(
  sonarStageService: SonarStageService,
  repoDir: string,
  expectedReleaseMergeBase: string,
): Promise<void> {
  console.log(chalk.bold.cyan('\nTest 2: scanIfEnabled uses --session-id, bypassing manifest/reflog'));
  const capturedScopes: unknown[] = [];
  const { reflogCallsRef, manifestCallsRef, restoreScan } = setupTest2Mocks(sonarStageService, capturedScopes);
  await sonarStageService.scanIfEnabled({ repoDir, force: true, ticketKey: 'WBP-1', providerSessionId: 'provider-abc', allowPrompt: true, onProgress: () => {} });
  checkTest2Results(reflogCallsRef, manifestCallsRef, capturedScopes, expectedReleaseMergeBase);
  restoreScan();
}

function mockRunSonarScan(capturedScopes: unknown[]): () => void {
  const originalRunSonarScan = sonarScannerModule.runSonarScan;
  (sonarScannerModule as unknown as Record<string, unknown>)['runSonarScan'] = async (opts: { scope: unknown }) => {
    capturedScopes.push(opts.scope);
    return { status: 'clean', steps: [] };
  };
  return (): void => {
    (sonarScannerModule as unknown as Record<string, unknown>)['runSonarScan'] = originalRunSonarScan;
  };
}

function mockManifestLookup(sonarStageService: SonarStageService, manifestCallsRef: { count: number }): void {
  const originalFindByBranchName = (sonarStageService as any).findManifestByBranchName.bind(sonarStageService);
  (sonarStageService as any).findManifestByBranchName = (...args: unknown[]) => {
    manifestCallsRef.count++;
    return originalFindByBranchName(...args);
  };
}

function mockServiceMethods(
  sonarStageService: SonarStageService,
): { reflogCallsRef: { count: number }; manifestCallsRef: { count: number } } {
  const reflogCallsRef = { count: 0 };
  const manifestCallsRef = { count: 0 };
  (sonarStageService as any).gitService.getBranchCreationSource = async () => {
    reflogCallsRef.count++;
    return null;
  };
  mockManifestLookup(sonarStageService, manifestCallsRef);
  return { reflogCallsRef, manifestCallsRef };
}

function setupTest2Mocks(
  sonarStageService: SonarStageService,
  capturedScopes: unknown[],
): {
  reflogCallsRef: { count: number };
  manifestCallsRef: { count: number };
  restoreScan: () => void;
} {
  const restoreScan = mockRunSonarScan(capturedScopes);
  const { reflogCallsRef, manifestCallsRef } = mockServiceMethods(sonarStageService);
  return { reflogCallsRef, manifestCallsRef, restoreScan };
}

function checkScopeResult(capturedScopes: unknown[], expectedReleaseMergeBase: string): void {
  const expectedScope = { kind: 'base', ref: expectedReleaseMergeBase };
  if (JSON.stringify(capturedScopes.at(-1)) === JSON.stringify(expectedScope)) {
    pass(`runSonarScan received the real release/2026 merge-base: ${expectedReleaseMergeBase}`);
  } else {
    fail('Expected the release/2026 merge-base scope', `got: ${JSON.stringify(capturedScopes.at(-1))}`);
  }
}

function checkTest2Results(
  reflogCallsRef: { count: number },
  manifestCallsRef: { count: number },
  capturedScopes: unknown[],
  expectedReleaseMergeBase: string,
): void {
  if (reflogCallsRef.count === 0 && manifestCallsRef.count === 0) {
    pass('Neither git reflog nor the plan-manifest lookup was called — Tier A short-circuited before Tier C');
  } else {
    fail('Expected reflog and manifest lookup to be skipped', `reflogCalls=${reflogCallsRef.count}, manifestCalls=${manifestCallsRef.count}`);
  }
  checkScopeResult(capturedScopes, expectedReleaseMergeBase);
}

async function main(): Promise<void> {
  console.log('Manual smoke: --session-id priority via findByProviderSessionId\n');
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error'] });
  const sonarStageService = app.get(SonarStageService);
  const sessionService = app.get(SessionService);
  const { repoDir, wfHome, originalWfHome } = setupWfEnvironment('sonar-session-id-', 'sonar-session-id-home-');
  setupSessionPriorityRepo(repoDir);
  const { expectedReleaseMergeBase } = computeAndValidateMergeBases(repoDir);
  await setupSessionsAndCheckTest1(sessionService);
  await runAndCheckTest2Bypass(sonarStageService, repoDir, expectedReleaseMergeBase);
  cleanupWfEnvironment(repoDir, wfHome, originalWfHome);
  await app.close();
  summarise(counts);
}

main().catch(error => {
  console.error(`\nManual smoke test failed: ${error.message}`);
  process.exit(1);
});
