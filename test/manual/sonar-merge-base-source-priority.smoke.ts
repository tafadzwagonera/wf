/**
 * Manual smoke test: sonar merge-base scope prefers a persisted source branch
 * over the branch-name heuristic, against real git merge-base output
 *
 * Verifies:
 *   1. Without a recorded manifest, the merge-base resolution uses the
 *      branch-name heuristic ('develop') and the resolved ref equals the
 *      real `git merge-base develop feature/WBP-1-thing` sha.
 *   2. With a manifest recording sourceBranch='release/2026' for the ticket,
 *      resolution uses that instead of the heuristic, and the resolved ref
 *      equals the real `git merge-base release/2026 feature/WBP-1-thing` sha.
 *
 * Run: nr test:manual sonar-merge-base-source-priority.smoke.ts
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { NestFactory } from '@nestjs/core';
import chalk from 'chalk';
import { AppModule } from '../../src/app.module';
import { SonarStageService } from '../../src/review/sonar-stage.service';
import * as sonarScannerModule from '../../src/review/sonar-scanner';
import { buildPlanArtifactManifest, writePlanArtifactManifest } from '../../src/shared/utils/plan-artifact';
import { resolveArtifactDir } from '../../src/agents/utils';

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

function initBaseCommit(repoDir: string): void {
  git(repoDir, ['init', '-q', '-b', 'master']);
  git(repoDir, ['config', 'user.email', 'test@example.com']);
  git(repoDir, ['config', 'user.name', 'Test']);
  fs.writeFileSync(path.join(repoDir, 'a.txt'), 'base\n');
  git(repoDir, ['add', 'a.txt']);
  git(repoDir, ['commit', '-q', '-m', 'base']);
}

function setupMergeBaseTestRepo(repoDir: string): void {
  initBaseCommit(repoDir);
  setupMergeBaseBranches(repoDir);
}

function setupMergeBaseBranches(repoDir: string): void {
  git(repoDir, ['checkout', '-q', '-b', 'develop']);
  fs.appendFileSync(path.join(repoDir, 'a.txt'), 'develop\n');
  git(repoDir, ['commit', '-q', '-am', 'develop work']);
  git(repoDir, ['checkout', '-q', 'master']);
  git(repoDir, ['checkout', '-q', '-b', 'release/2026']);
  fs.appendFileSync(path.join(repoDir, 'a.txt'), 'release\n');
  git(repoDir, ['commit', '-q', '-am', 'release work']);
  git(repoDir, ['checkout', '-q', '-b', 'feature/WBP-1-thing']);
  fs.appendFileSync(path.join(repoDir, 'a.txt'), 'feature\n');
  git(repoDir, ['commit', '-q', '-am', 'feature work']);
}

function computeMergeBases(repoDir: string): { expectedDevelopMergeBase: string; expectedReleaseMergeBase: string } {
  const expectedDevelopMergeBase = git(repoDir, ['merge-base', 'develop', 'feature/WBP-1-thing']);
  const expectedReleaseMergeBase = git(repoDir, ['merge-base', 'release/2026', 'feature/WBP-1-thing']);
  return { expectedDevelopMergeBase, expectedReleaseMergeBase };
}

function checkTestSetupValid(expectedReleaseMergeBase: string, expectedDevelopMergeBase: string): void {
  if (expectedReleaseMergeBase !== expectedDevelopMergeBase) {
    pass('Test setup valid: develop and release/2026 have different merge-bases with the feature branch');
  } else {
    fail('Test setup invalid: develop and release/2026 share a merge-base with the feature branch — cannot distinguish');
  }
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

function checkHeuristicPicksDevelop(capturedRefs: string[], expectedDevelopMergeBase: string): void {
  if (capturedRefs.at(-1) === expectedDevelopMergeBase) {
    pass(`Heuristic resolved base ref to develop's real merge-base: ${expectedDevelopMergeBase}`);
  } else {
    fail('Expected the develop merge-base sha', `got: ${capturedRefs.at(-1)}`);
  }
}

async function runTest1(
  sonarStageService: SonarStageService,
  repoDir: string,
  capturedRefs: string[],
  expectedDevelopMergeBase: string,
): Promise<void> {
  console.log(chalk.bold.cyan('\nTest 1: heuristic picks develop when no manifest is recorded'));
  await sonarStageService.scanIfEnabled({ repoDir, force: true, allowPrompt: true, onProgress: () => {} });
  checkHeuristicPicksDevelop(capturedRefs, expectedDevelopMergeBase);
}

async function runBothTests(
  sonarStageService: SonarStageService,
  repoDir: string,
  expectedDevelopMergeBase: string,
  expectedReleaseMergeBase: string,
): Promise<void> {
  const capturedRefs: string[] = [];
  const restore = mockSonarScanRefs(capturedRefs);
  await runTest1(sonarStageService, repoDir, capturedRefs, expectedDevelopMergeBase);
  await runTest2(sonarStageService, repoDir, capturedRefs, expectedReleaseMergeBase);
  restore();
}

function checkManifestSourceBranchWins(capturedRefs: string[], expectedReleaseMergeBase: string): void {
  if (capturedRefs.at(-1) === expectedReleaseMergeBase) {
    pass(`Manifest's sourceBranch used release/2026's real merge-base instead: ${expectedReleaseMergeBase}`);
  } else {
    fail('Expected the release/2026 merge-base sha', `got: ${capturedRefs.at(-1)}`);
  }
}

function buildTest2PlanManifest(artifactPath: string) {
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

function setupTest2Manifest(repoDir: string): void {
  const trackerDir = resolveArtifactDir(repoDir, 'jira');
  fs.mkdirSync(trackerDir, { recursive: true });
  const artifactPath = path.join(trackerDir, '2026-08-25-abc123-feature-plan.json');
  fs.writeFileSync(artifactPath, JSON.stringify({ action: 'feature', summary: 'x', steps: [], estimatedComplexity: 'low' }));
  const manifest = buildTest2PlanManifest(artifactPath);
  writePlanArtifactManifest({ ...manifest, sourceBranch: 'release/2026', branchName: 'feature/WBP-1-thing' });
}

async function runTest2(
  sonarStageService: SonarStageService,
  repoDir: string,
  capturedRefs: string[],
  expectedReleaseMergeBase: string,
): Promise<void> {
  console.log(chalk.bold.cyan('\nTest 2: manifest-recorded source branch wins over heuristic'));
  setupTest2Manifest(repoDir);
  await sonarStageService.scanIfEnabled({ repoDir, force: true, trackerName: 'jira', allowPrompt: true, onProgress: () => {} });
  checkManifestSourceBranchWins(capturedRefs, expectedReleaseMergeBase);
}

async function main(): Promise<void> {
  console.log('Manual smoke: sonar merge-base scope source-branch priority\n');
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error'] });
  const sonarStageService = app.get(SonarStageService);
  const { repoDir, wfHome, originalWfHome } = setupWfEnvironment('sonar-priority-', 'sonar-priority-home-');
  setupMergeBaseTestRepo(repoDir);
  const { expectedDevelopMergeBase, expectedReleaseMergeBase } = computeMergeBases(repoDir);
  checkTestSetupValid(expectedReleaseMergeBase, expectedDevelopMergeBase);
  await runBothTests(sonarStageService, repoDir, expectedDevelopMergeBase, expectedReleaseMergeBase);
  cleanupWfEnvironment(repoDir, wfHome, originalWfHome);
  await app.close();
  summarise(counts);
}

main().catch(error => {
  console.error(`\nManual smoke test failed: ${error.message}`);
  process.exit(1);
});
