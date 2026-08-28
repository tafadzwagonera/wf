/**
 * Manual smoke test: a genuinely custom plan (no ticketKey/customArtifactName)
 * resolves its session by sourceName, and that session wins over the
 * manifest's own sourceBranch field
 *
 * Verifies:
 *   1. A custom-plan manifest with only a sourceName (no ticketKey, no
 *      customArtifactName) is found by branch name.
 *   2. Its session lookup key falls all the way to `sourceName`, and
 *      SessionService.findByTicketKey('my-custom-plan') — a real, on-disk
 *      session — is what actually resolves.
 *   3. That session's sourceBranch (release/2026) wins over the manifest's own,
 *      deliberately different, sourceBranch field (develop).
 *   4. git reflog is never reached, since the session hit short-circuits first.
 *
 * Run: nr test:manual -- test-sonar-custom-plan-session-lookup
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
import { buildPlanArtifactManifest, writePlanArtifactManifest } from '../../src/shared/utils/plan-artifact';
import { resolveCustomArtifactDir } from '../../src/agents/utils';

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
  console.log('Manual smoke: custom-plan session lookup by sourceName\n');

  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error'] });
  const command = app.get(IssueReviewCommand);
  const sessionService = app.get(SessionService);

  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sonar-custom-session-'));
  const wfHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sonar-custom-session-home-'));
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

  git(repoDir, ['checkout', '-q', '-b', 'fix/my-custom-plan']);
  fs.appendFileSync(path.join(repoDir, 'a.txt'), 'feature\n');
  git(repoDir, ['commit', '-q', '-am', 'feature work']);

  const expectedDevelopMergeBase = git(repoDir, ['merge-base', 'develop', 'fix/my-custom-plan']);
  const expectedReleaseMergeBase = git(repoDir, ['merge-base', 'release/2026', 'fix/my-custom-plan']);
  if (expectedReleaseMergeBase === expectedDevelopMergeBase) {
    fail('Test setup invalid: develop and release/2026 share a merge-base with fix/my-custom-plan — cannot distinguish');
  } else {
    pass('Test setup valid: develop and release/2026 have different merge-bases with fix/my-custom-plan');
  }

  const customDir = resolveCustomArtifactDir(repoDir);
  fs.mkdirSync(customDir, { recursive: true });
  const artifactPath = path.join(customDir, '2026-08-25-abc123-fix-plan.json');
  fs.writeFileSync(
    artifactPath,
    JSON.stringify({ action: 'fix', summary: 'x', steps: [], estimatedComplexity: 'low' })
  );
  // No ticketKey, no customArtifactName — only sourceName. sourceBranch is deliberately
  // set to the "wrong" answer (develop) so the test can prove the session wins.
  writePlanArtifactManifest({
    ...buildPlanArtifactManifest({
      artifactPath, action: 'fix', format: 'json', hash: 'abc123',
      sourceName: 'my-custom-plan', sourceKind: 'custom', createdAt: new Date(),
    }),
    sourceBranch: 'develop',
    branchName: 'fix/my-custom-plan',
  });

  await sessionService.save({
    sessionId: 'session-custom', ticketKey: 'my-custom-plan', toStage: 'commit', action: 'fix',
    sourceType: 'custom', customPlanRef: 'my-custom-plan.md', sourceBranch: 'release/2026',
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), completedAt: null, stages: {},
  } as any);

  const found = await sessionService.findByTicketKey('my-custom-plan');
  if (found?.sourceBranch === 'release/2026') {
    pass("findByTicketKey('my-custom-plan') found the real session with sourceBranch release/2026");
  } else {
    fail("Expected the session keyed by 'my-custom-plan'", JSON.stringify(found));
  }

  const capturedScopes: unknown[] = [];
  const originalRunSonarScan = sonarScannerModule.runSonarScan;
  (sonarScannerModule as unknown as Record<string, unknown>)['runSonarScan'] = async (opts: { scope: unknown }) => {
    capturedScopes.push(opts.scope);
    return { status: 'clean', steps: [] };
  };

  let reflogCalls = 0;
  (command as any).gitService.getBranchCreationSource = async () => {
    reflogCalls++;
    return null;
  };

  const target = { repoDir, diff: '', title: '', context: '' };
  // No --ticket-key at all — custom plans have nothing to pass as one.
  await (command as any).resolveSonarOutputForTarget(target, { sonar: true }, () => {});

  if (reflogCalls === 0) {
    pass('git reflog was never called — the session-by-sourceName lookup resolved it first');
  } else {
    fail('Expected git reflog not to be called when the sourceName session lookup resolves the source branch');
  }

  const expectedScope = { kind: 'base', ref: expectedReleaseMergeBase };
  if (JSON.stringify(capturedScopes.at(-1)) === JSON.stringify(expectedScope)) {
    pass(`Session's sourceBranch (release/2026) won over the manifest's own field (develop): ${expectedReleaseMergeBase}`);
  } else {
    fail('Expected the release/2026 merge-base sha (from the session, not the manifest)', `got: ${JSON.stringify(capturedScopes.at(-1))}`);
  }

  (sonarScannerModule as unknown as Record<string, unknown>)['runSonarScan'] = originalRunSonarScan;

  fs.rmSync(repoDir, { recursive: true, force: true });
  fs.rmSync(wfHome, { recursive: true, force: true });
  if (originalWfHome === undefined) delete process.env.WF_HOME;
  else process.env.WF_HOME = originalWfHome;

  console.log(`\n${passed} passed, ${failed} failed`);
  await app.close();
  if (failed > 0) process.exit(1);
  console.log('\nManual smoke test passed: custom-plan session lookup by sourceName');
}

main().catch(error => {
  console.error(`\nManual smoke test failed: ${error.message}`);
  process.exit(1);
});
