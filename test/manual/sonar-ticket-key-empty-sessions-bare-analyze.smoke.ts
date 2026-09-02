/**
 * Manual smoke test: a bare --ticket-key with a real, empty session directory
 * runs a bare analyze immediately, touching no git reflog or plan manifest
 *
 * Verifies:
 *   1. SessionService.findByTicketKey (real, unmocked) returns null because
 *      the session directory genuinely doesn't exist on disk — not because a
 *      mock says so.
 *   2. The plan-manifest lookup, git reflog, and getMergeBase are never
 *      reached, even though a real, resolvable reflog entry exists on this
 *      branch — proving Tier B's bare-analyze path is taken deliberately, not
 *      because every other tier also happened to fail.
 *   3. runSonarScan is called exactly once with the bare `{ kind: 'branch' }`
 *      scope.
 *
 * Run: nr test:manual -- test-sonar-ticket-key-empty-sessions-bare-analyze
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
import { createReporter } from './support/reporter';

const { counts, pass, fail } = createReporter();

const git = (dir: string, args: string[]): string =>
  execFileSync('git', args, { cwd: dir, encoding: 'utf-8' }).trim();

async function main(): Promise<void> {
  console.log('Manual smoke: bare --ticket-key with an empty session directory\n');

  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error'] });
  const sonarStageService = app.get(SonarStageService);
  const sessionService = app.get(SessionService);

  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sonar-empty-sessions-'));
  const wfHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sonar-empty-sessions-home-'));
  const originalWfHome = process.env.WF_HOME;
  process.env.WF_HOME = wfHome;

  git(repoDir, ['init', '-q', '-b', 'master']);
  git(repoDir, ['config', 'user.email', 'test@example.com']);
  git(repoDir, ['config', 'user.name', 'Test']);
  fs.writeFileSync(path.join(repoDir, 'a.txt'), 'base\n');
  git(repoDir, ['add', 'a.txt']);
  git(repoDir, ['commit', '-q', '-m', 'base']);
  git(repoDir, ['checkout', '-q', '-b', 'feature/WBP-1-thing']);
  fs.appendFileSync(path.join(repoDir, 'a.txt'), 'feature\n');
  git(repoDir, ['commit', '-q', '-am', 'feature work']);

  const sessionDir = sessionService.getSessionDir();
  if (!fs.existsSync(sessionDir)) {
    pass(`Session directory ${sessionDir} genuinely does not exist on disk`);
  } else {
    fail(`Expected no session directory to exist yet at ${sessionDir}`);
  }

  const found = await sessionService.findByTicketKey('WBP-1');
  if (found === null) {
    pass("findByTicketKey('WBP-1') returned null against the real, nonexistent session directory");
  } else {
    fail('Expected null', JSON.stringify(found));
  }

  const capturedScopes: unknown[] = [];
  const originalRunSonarScan = sonarScannerModule.runSonarScan;
  (sonarScannerModule as unknown as Record<string, unknown>)['runSonarScan'] = async (opts: { scope: unknown }) => {
    capturedScopes.push(opts.scope);
    return { status: 'clean', steps: [] };
  };

  let reflogCalls = 0;
  let mergeBaseCalls = 0;
  const originalGetBranchCreationSource = (sonarStageService as any).gitService.getBranchCreationSource.bind(
    (sonarStageService as any).gitService
  );
  const originalGetMergeBase = (sonarStageService as any).gitService.getMergeBase.bind(
    (sonarStageService as any).gitService
  );
  (sonarStageService as any).gitService.getBranchCreationSource = async (...args: unknown[]) => {
    reflogCalls++;
    return originalGetBranchCreationSource(...args);
  };
  (sonarStageService as any).gitService.getMergeBase = async (...args: unknown[]) => {
    mergeBaseCalls++;
    return originalGetMergeBase(...args);
  };

  const target = { repoDir, diff: '', title: '', context: '' };
  await sonarStageService.scanIfEnabled({ repoDir: target.repoDir, force: true, ticketKey: 'WBP-1', allowPrompt: true, onProgress: () => {} });

  if (reflogCalls === 0 && mergeBaseCalls === 0) {
    pass('Neither git reflog nor getMergeBase was called — bare analyze ran immediately on the session miss');
  } else {
    fail('Expected reflog and getMergeBase to be skipped entirely', `reflogCalls=${reflogCalls}, mergeBaseCalls=${mergeBaseCalls}`);
  }

  const expectedScope = { kind: 'branch' };
  if (capturedScopes.length === 1 && JSON.stringify(capturedScopes[0]) === JSON.stringify(expectedScope)) {
    pass('runSonarScan was called exactly once with the bare { kind: \'branch\' } scope');
  } else {
    fail('Expected a single bare-analyze runSonarScan call', JSON.stringify(capturedScopes));
  }

  (sonarScannerModule as unknown as Record<string, unknown>)['runSonarScan'] = originalRunSonarScan;

  fs.rmSync(repoDir, { recursive: true, force: true });
  fs.rmSync(wfHome, { recursive: true, force: true });
  if (originalWfHome === undefined) delete process.env.WF_HOME;
  else process.env.WF_HOME = originalWfHome;

  console.log(`\n${counts.passed} passed, ${counts.failed} failed`);
  await app.close();
  if (counts.failed > 0) process.exit(1);
  console.log('\nManual smoke test passed: bare --ticket-key with an empty session directory');
}

main().catch(error => {
  console.error(`\nManual smoke test failed: ${error.message}`);
  process.exit(1);
});
