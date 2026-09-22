/**
 * Manual smoke test: --session-id with no matching session falls through to the
 * full Tier C chain instead of failing or skipping
 *
 * Verifies:
 *   1. SessionService.findByProviderSessionId (real, on-disk sessions) returns
 *      null for a provider session id that matches nothing.
 *   2. resolveSonarOutputForTarget then falls through to Tier C: the
 *      plan-manifest lookup by branch name IS called, and its result feeds a
 *      real git reflog read, which resolves the source branch.
 *   3. No interactive prompt is needed since reflog resolves it first.
 *
 * Run: nr test:manual sonar-session-id-fallthrough.smoke.ts
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
import { resolveArtifactDir } from '../../src/agents/utils';
import { createReporter, summarise } from './support/reporter';

const { counts, pass, fail } = createReporter();

const git = (dir: string, args: string[]): string =>
  execFileSync('git', args, { cwd: dir, encoding: 'utf-8' }).trim();

type WfEnvironmentSetup = {
  repoDir: string;
  wfHome: string;
  originalWfHome: string | undefined;
};

type FallthroughMocks = {
  manifestCallsRef: { count: number };
  restoreScan: () => void;
};

function setupWfEnvironment(prefix: string, homePrefix: string): WfEnvironmentSetup {
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

function setupFallthroughRepo(repoDir: string): void {
  git(repoDir, ['init', '-q', '-b', 'master']);
  git(repoDir, ['config', 'user.email', 'test@example.com']);
  git(repoDir, ['config', 'user.name', 'Test']);
  fs.writeFileSync(path.join(repoDir, 'a.txt'), 'base\n');
  git(repoDir, ['add', 'a.txt']);
  git(repoDir, ['commit', '-q', '-m', 'base']);
  git(repoDir, ['checkout', '-q', '-b', 'release/2026']);
  fs.appendFileSync(path.join(repoDir, 'a.txt'), 'release\n');
  git(repoDir, ['commit', '-q', '-am', 'release work']);
  // Real checkout -b with an explicit start-point -> real "Created from release/2026" reflog entry
  git(repoDir, ['checkout', '-q', '-b', 'feature/WBP-1-thing', 'release/2026']);
  fs.appendFileSync(path.join(repoDir, 'a.txt'), 'feature\n');
  git(repoDir, ['commit', '-q', '-am', 'feature work']);
}

function setupFallthroughScenario(repoDir: string): void {
  setupFallthroughRepo(repoDir);
  setupLegacyManifest(repoDir);
}

function writeFeatureArtifact(artifactPath: string): void {
  fs.writeFileSync(
    artifactPath,
    JSON.stringify({
      action: 'feature',
      summary: 'x',
      steps: [],
      estimatedComplexity: 'low',
    })
  );
}

function buildLegacyManifest(artifactPath: string): ReturnType<typeof buildPlanArtifactManifest> {
  return buildPlanArtifactManifest({
    artifactPath,
    action: 'feature',
    format: 'json',
    hash: 'abc123',
    sourceName: 'WBP-1',
    sourceKind: 'ticket',
    createdAt: new Date(),
  });
}

function setupLegacyManifest(repoDir: string): void {
  const trackerDir = resolveArtifactDir(repoDir, 'jira');
  fs.mkdirSync(trackerDir, { recursive: true });
  const artifactPath = path.join(trackerDir, '2026-08-25-abc123-feature-plan.json');
  writeFeatureArtifact(artifactPath);
  const manifest = buildLegacyManifest(artifactPath);
  writePlanArtifactManifest({ ...manifest, branchName: 'feature/WBP-1-thing' });
}

function setupSonarScanMock(
  capturedScopes: unknown[],
  originalRunSonarScan: unknown
): () => void {
  const mod = sonarScannerModule as unknown as Record<string, unknown>;
  mod['runSonarScan'] = async (opts: { scope: unknown }) => {
    capturedScopes.push(opts.scope);
    return { status: 'clean', steps: [] };
  };
  return () => {
    mod['runSonarScan'] = originalRunSonarScan;
  };
}

function setupManifestMock(
  sonarStageService: SonarStageService,
  manifestCallsRef: { count: number }
): void {
  const originalFindByBranchName = (
    sonarStageService as any
  ).findManifestByBranchName.bind(sonarStageService);
  (sonarStageService as any).findManifestByBranchName = (
    ...args: unknown[]
  ) => {
    manifestCallsRef.count++;
    return originalFindByBranchName(...args);
  };
}

async function checkSessionMiss(sessionService: SessionService): Promise<void> {
  const found = await sessionService.findByProviderSessionId('provider-does-not-exist', 'plan');
  if (found === null) {
    pass("findByProviderSessionId returned null for 'provider-does-not-exist'");
  } else {
    fail('Expected null', JSON.stringify(found));
  }
}

function setupFallthroughMocks(
  sonarStageService: SonarStageService,
  capturedScopes: unknown[]
): FallthroughMocks {
  const originalRunSonarScan = sonarScannerModule.runSonarScan;
  const restoreScan = setupSonarScanMock(capturedScopes, originalRunSonarScan);
  const manifestCallsRef = { count: 0 };
  setupManifestMock(sonarStageService, manifestCallsRef);
  return { manifestCallsRef, restoreScan };
}

function checkTierCEngaged(manifestCallsRef: { count: number }): void {
  if (manifestCallsRef.count > 0) {
    pass('findManifestByBranchName was called — Tier C was engaged after the Tier A miss');
  } else {
    fail('Expected the plan-manifest lookup to be called on a --session-id miss');
  }
}

function checkReflogRecoveredAfterMiss(capturedScopes: unknown[], expectedMergeBase: string): void {
  const expectedScope = { kind: 'base', ref: expectedMergeBase };
  if (JSON.stringify(capturedScopes.at(-1)) === JSON.stringify(expectedScope)) {
    pass(`Recovered release/2026 via reflog after the miss; merge-base matches: ${expectedMergeBase}`);
  } else {
    fail('Expected the release/2026 merge-base sha', `got: ${JSON.stringify(capturedScopes.at(-1))}`);
  }
}

async function runFallthroughScan(sonarStageService: SonarStageService, repoDir: string): Promise<void> {
  const capturedScopes: unknown[] = [];
  const { manifestCallsRef, restoreScan } = setupFallthroughMocks(sonarStageService, capturedScopes);
  const expectedMergeBase = git(repoDir, ['merge-base', 'release/2026', 'feature/WBP-1-thing']);
  // No inquirer wiring at all in this process — if the code required a prompt, it would hang or throw.
  await sonarStageService.scanIfEnabled({ repoDir, force: true, providerSessionId: 'provider-does-not-exist', allowPrompt: true, onProgress: () => {} });
  checkTierCEngaged(manifestCallsRef);
  checkReflogRecoveredAfterMiss(capturedScopes, expectedMergeBase);
  restoreScan();
}

async function main(): Promise<void> {
  console.log('Manual smoke: --session-id miss falls through to Tier C\n');
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error'] });
  const sonarStageService = app.get(SonarStageService);
  const sessionService = app.get(SessionService);
  const { repoDir, wfHome, originalWfHome } = setupWfEnvironment('sonar-session-id-fallthrough-', 'sonar-session-id-fallthrough-home-');
  setupFallthroughScenario(repoDir);
  await checkSessionMiss(sessionService);
  await runFallthroughScan(sonarStageService, repoDir);
  cleanupWfEnvironment(repoDir, wfHome, originalWfHome);
  await app.close();
  summarise(counts);
}

main().catch(error => {
  console.error(`\nManual smoke test failed: ${error.message}`);
  process.exit(1);
});
