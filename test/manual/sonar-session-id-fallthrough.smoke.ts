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
 * Run: nr test:manual -- test-sonar-session-id-fallthrough
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
  console.log('Manual smoke: --session-id miss falls through to Tier C\n');

  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error'] });
  const sonarStageService = app.get(SonarStageService);
  const sessionService = app.get(SessionService);

  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sonar-session-id-fallthrough-'));
  const wfHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sonar-session-id-fallthrough-home-'));
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

  const trackerDir = resolveArtifactDir(repoDir, 'jira');
  fs.mkdirSync(trackerDir, { recursive: true });
  const artifactPath = path.join(trackerDir, '2026-08-25-abc123-feature-plan.json');
  fs.writeFileSync(
    artifactPath,
    JSON.stringify({ action: 'feature', summary: 'x', steps: [], estimatedComplexity: 'low' })
  );
  // Legacy manifest: no sourceBranch field, findable by the current branch's name
  writePlanArtifactManifest({
    ...buildPlanArtifactManifest({
      artifactPath, action: 'feature', format: 'json', hash: 'abc123',
      sourceName: 'WBP-1', sourceKind: 'ticket', createdAt: new Date(),
    }),
    branchName: 'feature/WBP-1-thing',
  });

  // No session anywhere has this provider session id.
  const found = await sessionService.findByProviderSessionId('provider-does-not-exist', 'plan');
  if (found === null) {
    pass("findByProviderSessionId returned null for 'provider-does-not-exist'");
  } else {
    fail('Expected null', JSON.stringify(found));
  }

  const capturedScopes: unknown[] = [];
  const originalRunSonarScan = sonarScannerModule.runSonarScan;
  (sonarScannerModule as unknown as Record<string, unknown>)['runSonarScan'] = async (opts: { scope: unknown }) => {
    capturedScopes.push(opts.scope);
    return { status: 'clean', steps: [] };
  };

  let manifestCalls = 0;
  const originalFindByBranchName = (sonarStageService as any).findManifestByBranchName.bind(sonarStageService);
  (sonarStageService as any).findManifestByBranchName = (...args: unknown[]) => {
    manifestCalls++;
    return originalFindByBranchName(...args);
  };

  const expectedMergeBase = git(repoDir, ['merge-base', 'release/2026', 'feature/WBP-1-thing']);
  const target = { repoDir, diff: '', title: '', context: '' };

  // No inquirer wiring at all in this process — if the code required a prompt, it would hang or throw.
  await sonarStageService.scanIfEnabled({
    repoDir: target.repoDir,
    force: true,
    providerSessionId: 'provider-does-not-exist',
    allowPrompt: true,
    onProgress: () => {},
  });

  if (manifestCalls > 0) {
    pass('findManifestByBranchName was called — Tier C was engaged after the Tier A miss');
  } else {
    fail('Expected the plan-manifest lookup to be called on a --session-id miss');
  }

  const expectedScope = { kind: 'base', ref: expectedMergeBase };
  if (JSON.stringify(capturedScopes.at(-1)) === JSON.stringify(expectedScope)) {
    pass(`Recovered release/2026 via reflog after the miss; merge-base matches: ${expectedMergeBase}`);
  } else {
    fail('Expected the release/2026 merge-base sha', `got: ${JSON.stringify(capturedScopes.at(-1))}`);
  }

  (sonarScannerModule as unknown as Record<string, unknown>)['runSonarScan'] = originalRunSonarScan;

  fs.rmSync(repoDir, { recursive: true, force: true });
  fs.rmSync(wfHome, { recursive: true, force: true });
  if (originalWfHome === undefined) delete process.env.WF_HOME;
  else process.env.WF_HOME = originalWfHome;

  console.log(`\n${counts.passed} passed, ${counts.failed} failed`);
  await app.close();
  if (counts.failed > 0) process.exit(1);
  console.log('\nManual smoke test passed: --session-id miss falls through to Tier C');
}

main().catch(error => {
  console.error(`\nManual smoke test failed: ${error.message}`);
  process.exit(1);
});
