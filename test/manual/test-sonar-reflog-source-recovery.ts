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
 * Run: nr test:manual -- test-sonar-reflog-source-recovery
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { NestFactory } from '@nestjs/core';
import chalk from 'chalk';
import { AppModule } from '../../src/app.module';
import { IssueReviewCommand } from '../../src/commands/issue-review.command';
import { GitService } from '../../src/integrations/git/git.service';
import * as sonarScannerModule from '../../src/review/sonar-scanner';
import {
  buildPlanArtifactManifest, buildPlanArtifactManifestPath, writePlanArtifactManifest, readPlanArtifactManifest,
} from '../../src/shared/utils/plan-artifact';
import { resolveArtifactDir } from '../../src/agents/utils';

let passed = 0;
let failed = 0;

const pass = (message: string) => {
  console.log(chalk.green(`  PASS  ${message}`));
  passed++;
};

const fail = (message: string, detail?: string) => {
  const suffix = detail ? `\n    → ${detail}` : '';
  console.error(chalk.red(`  FAIL  ${message}${suffix}`));
  failed++;
};

const git = (dir: string, args: string[]): string =>
  execFileSync('git', args, { cwd: dir, encoding: 'utf-8' }).trim();

async function main(): Promise<void> {
  console.log('Manual smoke: git reflog source-branch recovery\n');

  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error'] });
  const command = app.get(IssueReviewCommand);
  const gitService = app.get(GitService);

  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sonar-reflog-'));
  const wfHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sonar-reflog-home-'));
  const originalWfHome = process.env.WF_HOME;
  process.env.WF_HOME = wfHome;

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

  console.log(chalk.bold.cyan('\nTest 1: GitService.getBranchCreationSource reads the real reflog'));
  const reflogSource = await gitService.getBranchCreationSource('feature/WBP-1-thing', repoDir);
  if (reflogSource === 'release/2026') {
    pass("getBranchCreationSource returned 'release/2026', read from the real reflog");
  } else {
    fail("Expected 'release/2026'", `got: ${reflogSource}`);
  }

  const trackerDir = resolveArtifactDir(repoDir, 'jira');
  fs.mkdirSync(trackerDir, { recursive: true });
  const artifactPath = path.join(trackerDir, '2026-08-25-abc123-feature-plan.json');
  fs.writeFileSync(
    artifactPath,
    JSON.stringify({ action: 'feature', summary: 'x', steps: [], estimatedComplexity: 'low' })
  );
  // Legacy manifest: no sourceBranch field at all. branchName lets it be found by the
  // current branch, since --ticket-key now bypasses manifest lookup entirely (Tier B).
  writePlanArtifactManifest({
    ...buildPlanArtifactManifest({ artifactPath: artifactPath, action: 'feature', format: 'json', hash: 'abc123', sourceName: 'WBP-1', sourceKind: 'ticket', createdAt: new Date() }),
    branchName: 'feature/WBP-1-thing',
  });

  const capturedRefs: string[] = [];
  const originalRunSonarScan = sonarScannerModule.runSonarScan;
  (sonarScannerModule as unknown as Record<string, unknown>)['runSonarScan'] = async (opts: { scope: { ref?: string } }) => {
    capturedRefs.push(opts.scope.ref ?? '(no ref)');
    return { status: 'clean', steps: [] };
  };

  console.log(chalk.bold.cyan('\nTest 2: recovery works non-interactively, with zero prompting'));
  const expectedMergeBase = git(repoDir, ['merge-base', 'release/2026', 'feature/WBP-1-thing']);
  const target = { repoDir, diff: '', title: '', context: '' };

  // No inquirer wiring at all in this process — if the code required a prompt, it would hang or throw.
  await (command as any).resolveSonarOutputForTarget(target, { sonar: true }, () => {});

  if (capturedRefs.at(-1) === expectedMergeBase) {
    pass(`Recovered release/2026 via reflog with no prompt; merge-base matches: ${expectedMergeBase}`);
  } else {
    fail('Expected the release/2026 merge-base sha', `got: ${capturedRefs.at(-1)}`);
  }

  console.log(chalk.bold.cyan('\nTest 3: recovered value is persisted to the manifest file on disk'));
  const manifestPath = buildPlanArtifactManifestPath(artifactPath);
  const persisted = readPlanArtifactManifest(manifestPath);
  if (persisted?.sourceBranch === 'release/2026') {
    pass('Manifest file on disk now records sourceBranch: release/2026');
  } else {
    fail('Expected persisted sourceBranch to be release/2026', `got: ${JSON.stringify(persisted)}`);
  }

  console.log(chalk.bold.cyan('\nTest 4: write-once — a hand-edit is not reverted by a second run'));
  writePlanArtifactManifest({ ...(persisted as NonNullable<typeof persisted>), sourceBranch: 'develop' });

  capturedRefs.length = 0;
  await (command as any).resolveSonarOutputForTarget(target, { sonar: true }, () => {});

  const afterSecondRun = readPlanArtifactManifest(manifestPath);
  if (afterSecondRun?.sourceBranch === 'develop') {
    pass('Hand-edited value (develop) survives a second run — write-once guard held');
  } else {
    fail('Expected the manifest to still say develop', `got: ${JSON.stringify(afterSecondRun)}`);
  }

  (sonarScannerModule as unknown as Record<string, unknown>)['runSonarScan'] = originalRunSonarScan;

  fs.rmSync(repoDir, { recursive: true, force: true });
  fs.rmSync(wfHome, { recursive: true, force: true });
  if (originalWfHome === undefined) delete process.env.WF_HOME;
  else process.env.WF_HOME = originalWfHome;

  console.log(`\n${passed} passed, ${failed} failed`);
  await app.close();
  if (failed > 0) process.exit(1);
  console.log('\nManual smoke test passed: git reflog source-branch recovery');
}

main().catch(error => {
  console.error(`\nManual smoke test failed: ${error.message}`);
  process.exit(1);
});
