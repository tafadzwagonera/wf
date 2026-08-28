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
 * Run: nr test:manual -- test-sonar-session-id-priority
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { NestFactory } from '@nestjs/core';
import chalk from 'chalk';
import { AppModule } from '../../src/app.module';
import { IssueReviewCommand } from '../../src/commands/issue-review.command';
import { SessionService } from '../../src/shared/session/session.service';
import * as sonarScannerModule from '../../src/review/sonar-scanner';

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
  console.log('Manual smoke: --session-id priority via findByProviderSessionId\n');

  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error'] });
  const command = app.get(IssueReviewCommand);
  const sessionService = app.get(SessionService);

  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sonar-session-id-'));
  const wfHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sonar-session-id-home-'));
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

  console.log(chalk.bold.cyan('\nTest 1: findByProviderSessionId picks the most recent match'));
  const planStage = (providerSessionId: string) => ({
    config: { provider: 'anthropic', backend: 'agent' }, model: 'claude', modelsUsed: [],
    providerSessionId, summary: null, startedAt: new Date().toISOString(), completedAt: null,
  });
  await sessionService.save({
    sessionId: 'older-session', ticketKey: 'WBP-1', toStage: 'commit', action: 'fix', sourceType: 'ticket',
    customPlanRef: null, sourceBranch: 'develop', createdAt: new Date('2026-01-01T00:00:00.000Z').toISOString(),
    updatedAt: new Date().toISOString(), completedAt: null, stages: { plan: planStage('provider-abc') },
  } as any);
  await sessionService.save({
    sessionId: 'newer-session', ticketKey: 'WBP-1', toStage: 'commit', action: 'fix', sourceType: 'ticket',
    customPlanRef: null, sourceBranch: 'release/2026', createdAt: new Date('2026-02-01T00:00:00.000Z').toISOString(),
    updatedAt: new Date().toISOString(), completedAt: null, stages: { plan: planStage('provider-abc') },
  } as any);

  const found = await sessionService.findByProviderSessionId('provider-abc', 'plan');
  if (found?.sessionId === 'newer-session' && found.sourceBranch === 'release/2026') {
    pass('findByProviderSessionId returned the newer session (release/2026), not the older one (develop)');
  } else {
    fail('Expected the newer session with sourceBranch release/2026', JSON.stringify(found));
  }

  console.log(chalk.bold.cyan('\nTest 2: resolveSonarOutputForTarget uses --session-id, bypassing manifest/reflog'));
  const capturedScopes: unknown[] = [];
  const originalRunSonarScan = sonarScannerModule.runSonarScan;
  (sonarScannerModule as unknown as Record<string, unknown>)['runSonarScan'] = async (opts: { scope: unknown }) => {
    capturedScopes.push(opts.scope);
    return { status: 'clean', steps: [] };
  };

  let reflogCalls = 0;
  let manifestCalls = 0;
  (command as any).gitService.getBranchCreationSource = async () => {
    reflogCalls++;
    return null;
  };
  const originalFindByBranchName = (command as any).findManifestByBranchName.bind(command);
  (command as any).findManifestByBranchName = (...args: unknown[]) => {
    manifestCalls++;
    return originalFindByBranchName(...args);
  };

  const target = { repoDir, diff: '', title: '', context: '' };
  await (command as any).resolveSonarOutputForTarget(
    target, { sonar: true, ticketKey: 'WBP-1', sessionId: 'provider-abc' }, () => {}
  );

  if (reflogCalls === 0 && manifestCalls === 0) {
    pass('Neither git reflog nor the plan-manifest lookup was called — Tier A short-circuited before Tier C');
  } else {
    fail('Expected reflog and manifest lookup to be skipped', `reflogCalls=${reflogCalls}, manifestCalls=${manifestCalls}`);
  }

  const expectedScope = { kind: 'base', ref: expectedReleaseMergeBase };
  if (JSON.stringify(capturedScopes.at(-1)) === JSON.stringify(expectedScope)) {
    pass(`runSonarScan received the real release/2026 merge-base: ${expectedReleaseMergeBase}`);
  } else {
    fail('Expected the release/2026 merge-base scope', `got: ${JSON.stringify(capturedScopes.at(-1))}`);
  }

  (sonarScannerModule as unknown as Record<string, unknown>)['runSonarScan'] = originalRunSonarScan;

  fs.rmSync(repoDir, { recursive: true, force: true });
  fs.rmSync(wfHome, { recursive: true, force: true });
  if (originalWfHome === undefined) delete process.env.WF_HOME;
  else process.env.WF_HOME = originalWfHome;

  console.log(`\n${passed} passed, ${failed} failed`);
  await app.close();
  if (failed > 0) process.exit(1);
  console.log('\nManual smoke test passed: --session-id priority via findByProviderSessionId');
}

main().catch(error => {
  console.error(`\nManual smoke test failed: ${error.message}`);
  process.exit(1);
});
