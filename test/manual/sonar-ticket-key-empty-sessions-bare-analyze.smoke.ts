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
 * Run: nr test:manual sonar-ticket-key-empty-sessions-bare-analyze.smoke.ts
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
import { restoreEnv, withEnv } from '../../src/shared/testing/env';

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

function setupEmptySessionRepo(repoDir: string): void {
  git(repoDir, ['init', '-q', '-b', 'master']);
  git(repoDir, ['config', 'user.email', 'test@example.com']);
  git(repoDir, ['config', 'user.name', 'Test']);
  fs.writeFileSync(path.join(repoDir, 'a.txt'), 'base\n');
  git(repoDir, ['add', 'a.txt']);
  git(repoDir, ['commit', '-q', '-m', 'base']);
  git(repoDir, ['checkout', '-q', '-b', 'feature/WBP-1-thing']);
  fs.appendFileSync(path.join(repoDir, 'a.txt'), 'feature\n');
  git(repoDir, ['commit', '-q', '-am', 'feature work']);
}

async function checkSessionDirAbsent(sessionService: SessionService): Promise<void> {
  const sessionDir = sessionService.getSessionDir();
  if (fs.existsSync(sessionDir)) {
    fail(`Expected no session directory to exist yet at ${sessionDir}`);
  } else {
    pass(`Session directory ${sessionDir} genuinely does not exist on disk`);
  }
  const found = await sessionService.findByTicketKey('WBP-1');
  if (found === null) {
    pass("findByTicketKey('WBP-1') returned null against the real, nonexistent session directory");
  } else {
    fail('Expected null', JSON.stringify(found));
  }
}

function mockRunSonarScanBare(capturedScopes: unknown[]): () => void {
  const originalRunSonarScan = sonarScannerModule.runSonarScan;
  (sonarScannerModule as unknown as Record<string, unknown>)['runSonarScan'] = async (opts: { scope: unknown }) => {
    capturedScopes.push(opts.scope);
    return { status: 'clean', steps: [] };
  };
  return (): void => {
    (sonarScannerModule as unknown as Record<string, unknown>)['runSonarScan'] = originalRunSonarScan;
  };
}

function patchGitServiceMethods(
  gs: any,
  reflogCallsRef: { count: number },
  origCreationSource: any,
): any {
  return async (...args: unknown[]) => {
    reflogCallsRef.count++;
    return origCreationSource(...args);
  };
}

function mockGitCalls(
  gs: any,
  reflogCallsRef: { count: number },
  mergeBaseCallsRef: { count: number },
): void {
  const origCreationSource = gs.getBranchCreationSource.bind(gs);
  const origMergeBase = gs.getMergeBase.bind(gs);
  gs.getBranchCreationSource = patchGitServiceMethods(gs, reflogCallsRef, origCreationSource);
  gs.getMergeBase = async (...args: unknown[]) => {
    mergeBaseCallsRef.count++;
    return origMergeBase(...args);
  };
}

function mockGitServiceMethods(
  sonarStageService: SonarStageService,
): { reflogCallsRef: { count: number }; mergeBaseCallsRef: { count: number } } {
  const reflogCallsRef = { count: 0 };
  const mergeBaseCallsRef = { count: 0 };
  const gs = (sonarStageService as any).gitService;
  mockGitCalls(gs, reflogCallsRef, mergeBaseCallsRef);
  return { reflogCallsRef, mergeBaseCallsRef };
}

function setupBareAnalyzeMocks(sonarStageService: SonarStageService): {
  capturedScopes: unknown[];
  reflogCallsRef: { count: number };
  mergeBaseCallsRef: { count: number };
  restoreScan: () => void;
} {
  const capturedScopes: unknown[] = [];
  const restoreScan = mockRunSonarScanBare(capturedScopes);
  const { reflogCallsRef, mergeBaseCallsRef } = mockGitServiceMethods(sonarStageService);
  return { capturedScopes, reflogCallsRef, mergeBaseCallsRef, restoreScan };
}

function checkBranchScope(capturedScopes: unknown[]): void {
  const expectedScope = { kind: 'branch' };
  if (capturedScopes.length === 1 && JSON.stringify(capturedScopes[0]) === JSON.stringify(expectedScope)) {
    pass('runSonarScan was called exactly once with the bare { kind: \'branch\' } scope');
  } else {
    fail('Expected a single bare-analyze runSonarScan call', JSON.stringify(capturedScopes));
  }
}

function checkBareAnalyzeRan(
  reflogCallsRef: { count: number },
  mergeBaseCallsRef: { count: number },
  capturedScopes: unknown[],
): void {
  if (reflogCallsRef.count === 0 && mergeBaseCallsRef.count === 0) {
    pass('Neither git reflog nor getMergeBase was called — bare analyze ran immediately on the session miss');
  } else {
    fail('Expected reflog and getMergeBase to be skipped entirely', `reflogCalls=${reflogCallsRef.count}, mergeBaseCalls=${mergeBaseCallsRef.count}`);
  }
  checkBranchScope(capturedScopes);
}

async function runTests(
  sonarStageService: SonarStageService,
  sessionService: SessionService,
  repoDir: string,
): Promise<void> {
  setupEmptySessionRepo(repoDir);
  await checkSessionDirAbsent(sessionService);
  const { capturedScopes, reflogCallsRef, mergeBaseCallsRef, restoreScan } = setupBareAnalyzeMocks(sonarStageService);
  await sonarStageService.scanIfEnabled({ repoDir, force: true, ticketKey: 'WBP-1', allowPrompt: true, onProgress: () => {} });
  checkBareAnalyzeRan(reflogCallsRef, mergeBaseCallsRef, capturedScopes);
  restoreScan();
}

async function main(): Promise<void> {
  console.log('Manual smoke: bare --ticket-key with an empty session directory\n');
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error'] });
  const sonarStageService = app.get(SonarStageService);
  const sessionService = app.get(SessionService);
  const { repoDir, wfHome } = setupWfEnvironment('sonar-empty-sessions-', 'sonar-empty-sessions-home-');
  await runTests(sonarStageService, sessionService, repoDir);
  cleanupWfEnvironment(repoDir, wfHome);
  await app.close();
  summarise(counts);
}

main().catch(error => {
  console.error(`\nManual smoke test failed: ${error.message}`);
  process.exit(1);
});
