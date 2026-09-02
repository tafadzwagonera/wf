/**
 * Manual smoke test: getChangedFilesSince mirrors real git diff scope —
 * including the untracked-file blind spot — and that list reaches the
 * secrets scan in the merge-base sonar fallback
 *
 * Verifies:
 *   1. GitService.getChangedFilesSince returns exactly the tracked/staged
 *      changed files, matching real `git diff --name-only <ref>` output.
 *   2. A completely untracked file (never `git add`ed) is excluded — the
 *      real git-level blind spot this fix inherits from `git diff`.
 *   3. resolveSonarOutputForTarget's merge-base path forwards that exact
 *      file list as secretPaths into runSonarScan.
 *
 * Run: nr test:manual -- test-sonar-changed-files-since-scope
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
import { buildPlanArtifactManifest, writePlanArtifactManifest } from '../../src/shared/utils/plan-artifact';
import { resolveArtifactDir } from '../../src/agents/utils';

import { createReporter } from './support/reporter';

const { counts, pass, fail } = createReporter();

const git = (dir: string, args: string[]): string =>
  execFileSync('git', args, { cwd: dir, encoding: 'utf-8' }).trim();

async function main(): Promise<void> {
  console.log('Manual smoke: getChangedFilesSince real diff scope\n');

  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error'] });
  const sonarStageService = app.get(SonarStageService);
  const gitService = app.get(GitService);

  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sonar-changed-files-'));
  const wfHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sonar-changed-files-home-'));
  const originalWfHome = process.env.WF_HOME;
  process.env.WF_HOME = wfHome;

  git(repoDir, ['init', '-q', '-b', 'master']);
  git(repoDir, ['config', 'user.email', 'test@example.com']);
  git(repoDir, ['config', 'user.name', 'Test']);
  fs.writeFileSync(path.join(repoDir, 'tracked.txt'), 'base\n');
  git(repoDir, ['add', 'tracked.txt']);
  git(repoDir, ['commit', '-q', '-m', 'base']);

  git(repoDir, ['checkout', '-q', '-b', 'feature/x']);
  fs.appendFileSync(path.join(repoDir, 'tracked.txt'), 'change\n'); // unstaged modification
  fs.writeFileSync(path.join(repoDir, 'staged-new.txt'), 'secret-ish\n');
  git(repoDir, ['add', 'staged-new.txt']); // staged new file
  fs.writeFileSync(path.join(repoDir, 'untracked-new.txt'), 'never-added\n'); // never git add'ed

  const mergeBaseSha = git(repoDir, ['merge-base', 'master', 'feature/x']);
  const expectedFiles = git(repoDir, ['diff', '--name-only', mergeBaseSha]).split('\n').filter(Boolean).sort();

  console.log(chalk.bold.cyan('\nTest 1: getChangedFilesSince matches real git diff --name-only output'));
  const actualFiles = (await gitService.getChangedFilesSince(mergeBaseSha, repoDir)).slice().sort();
  if (JSON.stringify(actualFiles) === JSON.stringify(expectedFiles)) {
    pass(`getChangedFilesSince returned ${JSON.stringify(actualFiles)}, matching real git diff output`);
  } else {
    fail('Mismatch with real git diff output', `expected ${JSON.stringify(expectedFiles)}, got ${JSON.stringify(actualFiles)}`);
  }

  console.log(chalk.bold.cyan('\nTest 2: untracked-new.txt (never git add\'ed) is excluded'));
  if (actualFiles.includes('untracked-new.txt')) {
    fail('untracked-new.txt should not appear in the changed-files list');
  } else {
    pass('untracked-new.txt correctly absent — git diff blind spot confirmed');
  }
  if (actualFiles.includes('tracked.txt') && actualFiles.includes('staged-new.txt')) {
    pass('tracked.txt (unstaged mod) and staged-new.txt (staged new file) are both included');
  } else {
    fail('Expected both tracked.txt and staged-new.txt to be included', JSON.stringify(actualFiles));
  }

  console.log(chalk.bold.cyan('\nTest 3: resolveSonarOutputForTarget forwards this exact list as secretPaths'));
  git(repoDir, ['commit', '-q', '-am', 'feature work']);
  const trackerDir = resolveArtifactDir(repoDir, 'jira');
  fs.mkdirSync(trackerDir, { recursive: true });
  const artifactPath = path.join(trackerDir, '2026-08-25-abc123-feature-plan.json');
  fs.writeFileSync(
    artifactPath,
    JSON.stringify({ action: 'feature', summary: 'x', steps: [], estimatedComplexity: 'low' })
  );

  writePlanArtifactManifest({
    ...buildPlanArtifactManifest({ artifactPath: artifactPath, action: 'feature', format: 'json', hash: 'abc123', sourceName: 'WBP-1', sourceKind: 'ticket', createdAt: new Date() }),
    sourceBranch: 'master',
    branchName: 'feature/x',
  });
  let capturedSecretPaths: string[] | undefined;
  const originalRunSonarScan = sonarScannerModule.runSonarScan;
  (sonarScannerModule as unknown as Record<string, unknown>)['runSonarScan'] = async (opts: { secretPaths?: string[] }) => {
    capturedSecretPaths = opts.secretPaths;
    return { status: 'clean', steps: [] };
  };

  const target = { repoDir, diff: '', title: '', context: '' };
  await sonarStageService.scanIfEnabled({
    repoDir: target.repoDir, force: true, trackerName: 'jira', allowPrompt: true, onProgress: () => {},
  });

  const capturedSorted = (capturedSecretPaths ?? []).slice().sort();
  if (JSON.stringify(capturedSorted) === JSON.stringify(expectedFiles)) {
    pass(`runSonarScan received secretPaths matching the real changed-files list: ${JSON.stringify(capturedSorted)}`);
  } else {
    fail('secretPaths mismatch', `expected ${JSON.stringify(expectedFiles)}, got ${JSON.stringify(capturedSorted)}`);
  }

  (sonarScannerModule as unknown as Record<string, unknown>)['runSonarScan'] = originalRunSonarScan;

  fs.rmSync(repoDir, { recursive: true, force: true });
  fs.rmSync(wfHome, { recursive: true, force: true });
  if (originalWfHome === undefined) delete process.env.WF_HOME;
  else process.env.WF_HOME = originalWfHome;

  console.log(`\n${counts.passed} passed, ${counts.failed} failed`);
  await app.close();
  if (counts.failed > 0) process.exit(1);
  console.log('\nManual smoke test passed: getChangedFilesSince real diff scope');
}

main().catch(error => {
  console.error(`\nManual smoke test failed: ${error.message}`);
  process.exit(1);
});
