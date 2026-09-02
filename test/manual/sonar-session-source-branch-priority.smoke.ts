/**
 * Manual smoke test: a persisted session's recorded sourceBranch takes priority
 * over a plan manifest's own sourceBranch field, for both the ticket-key path
 * (Tier B) and the no-ticket-key path (Tier C), against real git merge-base output
 *
 * Verifies:
 *   1. Tier B: `-k <ticketKey>` alone finds the session by ticket key directly
 *      (no manifest lookup at all) and scopes the merge-base scan to its
 *      sourceBranch.
 *   2. Tier C: with no ticket key, a manifest is found by branch name, but the
 *      session recorded for the manifest's own identifier wins over the
 *      manifest's own (different) sourceBranch field.
 *
 * Run: nr test:manual -- test-sonar-session-source-branch-priority
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
import { createReporter } from './support/reporter';

const { counts, pass, fail } = createReporter();

const git = (dir: string, args: string[]): string =>
  execFileSync('git', args, { cwd: dir, encoding: 'utf-8' }).trim();

async function main(): Promise<void> {
  console.log('Manual smoke: session sourceBranch priority over manifest\n');

  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error'] });
  const sonarStageService = app.get(SonarStageService);
  const sessionService = app.get(SessionService);

  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sonar-session-priority-'));
  const wfHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sonar-session-priority-home-'));
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
  if (expectedReleaseMergeBase === expectedDevelopMergeBase) {
    fail('Test setup invalid: develop and release/2026 share a merge-base with the feature branch — cannot distinguish');
  } else {
    pass('Test setup valid: develop and release/2026 have different merge-bases with the feature branch');
  }

  const capturedRefs: string[] = [];
  const originalRunSonarScan = sonarScannerModule.runSonarScan;
  (sonarScannerModule as unknown as Record<string, unknown>)['runSonarScan'] = async (opts: { scope: { ref?: string } }) => {
    capturedRefs.push(opts.scope.ref ?? '(no ref)');
    return { status: 'clean', steps: [] };
  };

  const target = { repoDir, diff: '', title: '', context: '' };

  console.log(chalk.bold.cyan('\nTest 1 (Tier B): a bare ticket key finds the session by ticket key directly'));
  const ticketSession = await sessionService.save({
    sessionId: 'session-wbp-1', ticketKey: 'WBP-1', toStage: 'commit', action: 'fix', sourceType: 'ticket',
    customPlanRef: null, sourceBranch: 'release/2026', createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(), completedAt: null, stages: {},
  } as any).then(() => sessionService.findByTicketKey('WBP-1'));
  if (ticketSession?.sourceBranch === 'release/2026') {
    pass('Session persisted and found by ticket key with sourceBranch: release/2026');
  } else {
    fail('Expected the session to be found with sourceBranch release/2026', JSON.stringify(ticketSession));
  }

  await sonarStageService.scanIfEnabled({ repoDir: target.repoDir, force: true, ticketKey: 'WBP-1', allowPrompt: true, onProgress: () => {} });

  if (capturedRefs.at(-1) === expectedReleaseMergeBase) {
    pass(`Tier B used the session's sourceBranch — real merge-base: ${expectedReleaseMergeBase}`);
  } else {
    fail('Expected the release/2026 merge-base sha', `got: ${capturedRefs.at(-1)}`);
  }

  console.log(chalk.bold.cyan(
    '\nTest 2 (Tier C): the session recorded for the manifest\'s identifier wins over the manifest\'s own sourceBranch'
  ));
  const trackerDir = resolveArtifactDir(repoDir, 'jira');
  fs.mkdirSync(trackerDir, { recursive: true });
  const artifactPath = path.join(trackerDir, '2026-08-25-abc123-feature-plan.json');
  fs.writeFileSync(
    artifactPath,
    JSON.stringify({ action: 'feature', summary: 'x', steps: [], estimatedComplexity: 'low' })
  );
  const manifest = buildPlanArtifactManifest({
    artifactPath, action: 'feature', format: 'json', hash: 'abc123',
    sourceName: 'WBP-1', sourceKind: 'ticket', createdAt: new Date(),
  });
  // The manifest's own field says 'develop' — the session recorded for WBP-1 says
  // 'release/2026' and must win, since it's the more reliable, orchestrator-written anchor.
  writePlanArtifactManifest({
    ...manifest, sourceBranch: 'develop', branchName: 'feature/WBP-1-thing',
  });

  capturedRefs.length = 0;
  await sonarStageService.scanIfEnabled({
    repoDir: target.repoDir, force: true, trackerName: 'jira', allowPrompt: true, onProgress: () => {},
  });

  if (capturedRefs.at(-1) === expectedReleaseMergeBase) {
    pass(`Tier C preferred the session's sourceBranch over the manifest field — real merge-base: ${expectedReleaseMergeBase}`);
  } else {
    fail('Expected the release/2026 merge-base sha (from the session, not the manifest)', `got: ${capturedRefs.at(-1)}`);
  }

  (sonarScannerModule as unknown as Record<string, unknown>)['runSonarScan'] = originalRunSonarScan;

  fs.rmSync(repoDir, { recursive: true, force: true });
  fs.rmSync(wfHome, { recursive: true, force: true });
  if (originalWfHome === undefined) delete process.env.WF_HOME;
  else process.env.WF_HOME = originalWfHome;

  console.log(`\n${counts.passed} passed, ${counts.failed} failed`);
  await app.close();
  if (counts.failed > 0) process.exit(1);
  console.log('\nManual smoke test passed: session sourceBranch priority over manifest');
}

main().catch(error => {
  console.error(`\nManual smoke test failed: ${error.message}`);
  process.exit(1);
});
