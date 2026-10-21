/**
 * Manual smoke test: git reflog recovers a legacy manifest's source branch
 * without prompting, and the recovery is write-once
 *
 * Verifies:
 *   1. A feature branch created via a real `git checkout -b <name> <base>`
 *      has a real reflog entry GitService.getBranchCreationSource can read.
 *   2. resolveSonarOutputForTarget recovers that source branch for a legacy
 *      manifest (no sourceBranch field) with zero interactive prompting.
 *   3. The recovered value is persisted to the manifest file on disk.
 *   4. A later hand-edit to the manifest is NOT reverted by a second call —
 *      write-once holds even when reflog would suggest a different answer.
 *
 * Run: nr test:manual sonar-reflog-source-recovery.smoke.ts
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { NestFactory } from '@nestjs/core';
import chalk from 'chalk';
import { AppModule } from '../../src/app.module';
import { SonarStageService } from '../../src/review/sonar-stage.service';
import { GitService } from '../../src/integrations/git/git.service';
import * as sonarScannerModule from '../../src/review/sonar-scanner';
import {
  buildPlanArtifactManifest, buildPlanArtifactManifestPath, writePlanArtifactManifest, readPlanArtifactManifest,
} from '../../src/common/utils/plan-artifact';
import { resolveArtifactDir } from '../../src/agents/utils';

import { createReporter, summarise } from './support/reporter';
import { restoreEnv, withEnv } from '../../src/common/testing/env';

const { counts, pass, fail } = createReporter();

const git = (dir: string, args: string[]): string =>
  execFileSync('git', args, { cwd: dir, encoding: 'utf-8' }).trim();

function setupWfEnvironment(
  prefix: string,
  homePrefix: string,
): { repoDir: string; wfHome: string } {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const wfHome = fs.mkdtempSync(path.join(os.tmpdir(), homePrefix));
  withEnv({ WF_HOME: wfHome });
  return { repoDir, wfHome };
}

function cleanupWfEnvironment(repoDir: string, wfHome: string): void {
  fs.rmSync(repoDir, { recursive: true, force: true });
  fs.rmSync(wfHome, { recursive: true, force: true });
  restoreEnv();
}

function setupReflogScenario(repoDir: string): void {
  setupReflogRepo(repoDir);
  setupLegacyManifest(repoDir);
}

function setupReflogRepo(repoDir: string): void {
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

async function runAndCheckTest1(gitService: GitService, repoDir: string): Promise<void> {
  console.log(chalk.bold.cyan('\nTest 1: GitService.getBranchCreationSource reads the real reflog'));
  const reflogSource = await gitService.getBranchCreationSource('feature/WBP-1-thing', repoDir);
  if (reflogSource === 'release/2026') {
    pass("getBranchCreationSource returned 'release/2026', read from the real reflog");
  } else {
    fail("Expected 'release/2026'", `got: ${reflogSource}`);
  }
}

function setupLegacyManifest(repoDir: string): string {
  const trackerDir = resolveArtifactDir(repoDir, 'jira');
  fs.mkdirSync(trackerDir, { recursive: true });
  const artifactPath = path.join(trackerDir, '2026-08-25-abc123-feature-plan.json');
  fs.writeFileSync(artifactPath, JSON.stringify({ action: 'feature', summary: 'x', steps: [], estimatedComplexity: 'low' }));
  writePlanArtifactManifest({
    ...buildPlanArtifactManifest({ artifactPath, action: 'feature', format: 'json', hash: 'abc123', sourceName: 'WBP-1', sourceKind: 'ticket', createdAt: new Date() }),
    branchName: 'feature/WBP-1-thing',
  });
  return artifactPath;
}

function mockSonarScanRefs(capturedRefs: string[]): () => void {
  const originalRunSonarScan = sonarScannerModule.runSonarScan;
  (sonarScannerModule as unknown as Record<string, unknown>)['runSonarScan'] = async (opts: { scope: { ref?: string } }) => {
    capturedRefs.push(opts.scope.ref ?? '(no ref)');
    return { status: 'clean', steps: [] };
  };
  return () => {
    (sonarScannerModule as unknown as Record<string, unknown>)['runSonarScan'] = originalRunSonarScan;
  };
}

function getManifestPathForTest2(repoDir: string): string {
  const artifactPath = path.join(
    resolveArtifactDir(repoDir, 'jira'),
    '2026-08-25-abc123-feature-plan.json',
  );
  return buildPlanArtifactManifestPath(artifactPath);
}

async function runScanWithTracking(
  sonarStageService: SonarStageService,
  repoDir: string,
): Promise<string[]> {
  const capturedRefs: string[] = [];
  const restore = mockSonarScanRefs(capturedRefs);
  await sonarStageService.scanIfEnabled({ repoDir, force: true, trackerName: 'jira', allowPrompt: true, onProgress: () => {} });
  restore();
  return capturedRefs;
}

function verifyRecoveryResult(capturedRefs: string[], expectedMergeBase: string): void {
  if (capturedRefs.at(-1) === expectedMergeBase) {
    pass(`Recovered release/2026 via reflog with no prompt; merge-base matches: ${expectedMergeBase}`);
  } else {
    fail('Expected the release/2026 merge-base sha', `got: ${capturedRefs.at(-1)}`);
  }
}

async function verifyScanRecovery(
  sonarStageService: SonarStageService,
  repoDir: string,
  expectedMergeBase: string,
): Promise<void> {
  const capturedRefs = await runScanWithTracking(sonarStageService, repoDir);
  verifyRecoveryResult(capturedRefs, expectedMergeBase);
}

type Test2Result = { manifestPath: string; persisted: ReturnType<typeof readPlanArtifactManifest> };

async function runAndCheckTest2(
  sonarStageService: SonarStageService,
  repoDir: string,
): Promise<Test2Result> {
  console.log(chalk.bold.cyan('\nTest 2: recovery works non-interactively, with zero prompting'));
  const expectedMergeBase = git(repoDir, ['merge-base', 'release/2026', 'feature/WBP-1-thing']);
  await verifyScanRecovery(sonarStageService, repoDir, expectedMergeBase);
  const manifestPath = getManifestPathForTest2(repoDir);
  return { manifestPath, persisted: readPlanArtifactManifest(manifestPath) };
}

function checkManifestPersisted(persisted: ReturnType<typeof readPlanArtifactManifest>): void {
  console.log(chalk.bold.cyan('\nTest 3: recovered value is persisted to the manifest file on disk'));
  if (persisted?.sourceBranch === 'release/2026') {
    pass('Manifest file on disk now records sourceBranch: release/2026');
  } else {
    fail('Expected persisted sourceBranch to be release/2026', `got: ${JSON.stringify(persisted)}`);
  }
}

function checkManifestUnchanged(manifestPath: string): void {
  const afterSecondRun = readPlanArtifactManifest(manifestPath);
  if (afterSecondRun?.sourceBranch === 'develop') {
    pass('Hand-edited value (develop) survives a second run — write-once guard held');
  } else {
    fail('Expected the manifest to still say develop', `got: ${JSON.stringify(afterSecondRun)}`);
  }
}

async function verifyWriteOnceGuard(
  sonarStageService: SonarStageService,
  repoDir: string,
  manifestPath: string,
): Promise<void> {
  await sonarStageService.scanIfEnabled({
    repoDir,
    force: true,
    trackerName: 'jira',
    allowPrompt: true,
    onProgress: () => {},
  });
  checkManifestUnchanged(manifestPath);
}

async function runAndCheckTest4(
  sonarStageService: SonarStageService,
  repoDir: string,
  manifestPath: string,
  persisted: NonNullable<ReturnType<typeof readPlanArtifactManifest>>,
): Promise<void> {
  console.log(chalk.bold.cyan('\nTest 4: write-once — a hand-edit is not reverted by a second run'));
  writePlanArtifactManifest({ ...persisted, sourceBranch: 'develop' });
  await verifyWriteOnceGuard(sonarStageService, repoDir, manifestPath);
}

async function main(): Promise<void> {
  console.log('Manual smoke: git reflog source-branch recovery\n');
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error'] });
  const sonarStageService = app.get(SonarStageService);
  const gitService = app.get(GitService);
  const { repoDir, wfHome } = setupWfEnvironment('sonar-reflog-', 'sonar-reflog-home-');
  setupReflogScenario(repoDir);
  await runAndCheckTest1(gitService, repoDir);
  const { manifestPath, persisted } = await runAndCheckTest2(sonarStageService, repoDir);
  checkManifestPersisted(persisted);
  await runAndCheckTest4(sonarStageService, repoDir, manifestPath, persisted as NonNullable<typeof persisted>);
  cleanupWfEnvironment(repoDir, wfHome);
  await app.close();
  summarise(counts);
}

main().catch(error => {
  console.error(`\nManual smoke test failed: ${error.message}`);
  process.exit(1);
});
