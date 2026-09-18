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
 * Run: nr test:manual -- test-sonar-merge-base-source-priority
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

import { createReporter } from './support/reporter';

const { counts, pass, fail } = createReporter();

const git = (dir: string, args: string[]): string =>
  execFileSync('git', args, { cwd: dir, encoding: 'utf-8' }).trim();

async function main(): Promise<void> {
  console.log('Manual smoke: sonar merge-base scope source-branch priority\n');

  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error'] });
  const sonarStageService = app.get(SonarStageService);

  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sonar-priority-'));
  const wfHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sonar-priority-home-'));
  const originalWfHome = process.env.WF_HOME;
  process.env.WF_HOME = wfHome;

  git(repoDir, ['init', '-q', '-b', 'master']);
  git(repoDir, ['config', 'user.email', 'test@example.com']);
  git(repoDir, ['config', 'user.name', 'Test']);
  fs.writeFileSync(path.join(repoDir, 'a.txt'), 'base\n');
  git(repoDir, ['add', 'a.txt']);
  git(repoDir, ['commit', '-q', '-m', 'base']);

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

  const expectedDevelopMergeBase = git(repoDir, ['merge-base', 'develop', 'feature/WBP-1-thing']);
  const expectedReleaseMergeBase = git(repoDir, ['merge-base', 'release/2026', 'feature/WBP-1-thing']);
  if (expectedReleaseMergeBase !== expectedDevelopMergeBase) {
    pass('Test setup valid: develop and release/2026 have different merge-bases with the feature branch');
  } else {
    fail('Test setup invalid: develop and release/2026 share a merge-base with the feature branch — cannot distinguish');
  }

  const capturedRefs: string[] = [];
  const originalRunSonarScan = sonarScannerModule.runSonarScan;
  (sonarScannerModule as unknown as Record<string, unknown>)['runSonarScan'] = async (opts: { scope: { ref?: string } }) => {
    capturedRefs.push(opts.scope.ref ?? '(no ref)');
    return { status: 'clean', steps: [] };
  };

  const target = { repoDir, diff: '', title: '', context: '' };

  console.log(chalk.bold.cyan('\nTest 1: heuristic picks develop when no manifest is recorded'));
  await sonarStageService.scanIfEnabled({
    repoDir: target.repoDir, force: true, allowPrompt: true, onProgress: () => {},
  });

  if (capturedRefs.at(-1) === expectedDevelopMergeBase) {
    pass(`Heuristic resolved base ref to develop's real merge-base: ${expectedDevelopMergeBase}`);
  } else {
    fail('Expected the develop merge-base sha', `got: ${capturedRefs.at(-1)}`);
  }

  console.log(chalk.bold.cyan('\nTest 2: manifest-recorded source branch wins over heuristic'));
  const trackerDir = resolveArtifactDir(repoDir, 'jira');
  fs.mkdirSync(trackerDir, { recursive: true });
  const artifactPath = path.join(trackerDir, '2026-08-25-abc123-feature-plan.json');
  fs.writeFileSync(
    artifactPath,
    JSON.stringify({ action: 'feature', summary: 'x', steps: [], estimatedComplexity: 'low' })
  );
  const manifest = buildPlanArtifactManifest({ artifactPath: artifactPath, action: 'feature', format: 'json', hash: 'abc123', sourceName: 'WBP-1', sourceKind: 'ticket', createdAt: new Date() });
  // branchName lets it be found by the current branch — --ticket-key now bypasses
  // manifest lookup entirely (Tier B), so this exercises the no-ticket-key branch-name path.
  writePlanArtifactManifest({ ...manifest, sourceBranch: 'release/2026', branchName: 'feature/WBP-1-thing' });

  await sonarStageService.scanIfEnabled({
    repoDir: target.repoDir, force: true, trackerName: 'jira', allowPrompt: true, onProgress: () => {},
  });

  if (capturedRefs.at(-1) === expectedReleaseMergeBase) {
    pass(`Manifest's sourceBranch used release/2026's real merge-base instead: ${expectedReleaseMergeBase}`);
  } else {
    fail('Expected the release/2026 merge-base sha', `got: ${capturedRefs.at(-1)}`);
  }

  (sonarScannerModule as unknown as Record<string, unknown>)['runSonarScan'] = originalRunSonarScan;

  fs.rmSync(repoDir, { recursive: true, force: true });
  fs.rmSync(wfHome, { recursive: true, force: true });
  if (originalWfHome === undefined) delete process.env.WF_HOME;
  else process.env.WF_HOME = originalWfHome;

  console.log(`\n${counts.passed} passed, ${counts.failed} failed`);
  await app.close();
  if (counts.failed > 0) process.exit(1);
  console.log('\nManual smoke test passed: sonar merge-base source-branch priority');
}

main().catch(error => {
  console.error(`\nManual smoke test failed: ${error.message}`);
  process.exit(1);
});
