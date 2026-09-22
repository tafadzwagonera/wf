/**
 * Smoke test: per-repo review artifact paths are distinct in a multi-repo run
 *
 * Run: nr test:manual multi-repo-review-artifact-isolation.smoke.ts
 *
 * Scenario: Before this fix, deriveReviewArtifactPath produced the same path for
 * every repo, so repo 2's ReviewerAgent.execute would reuse repo 1's cached artifact.
 * After the fix, repoScope = path.basename(options.repoDir) is threaded through
 * ReviewStageService.buildReviewArtifact to deriveReviewArtifactPath, which appends
 * -<repoScope>-review.md instead of -review.md.
 *
 * Verify:
 *   1. deriveReviewArtifactPath(path, 'repo-shop') appends -repo-shop-review.md
 *   2. deriveReviewArtifactPath(path) appends -review.md (callers without scope unaffected)
 *   3. buildReviewArtifact(ticket, review, undefined, 'repo-api').path has -repo-api-review.md
 *   4. ReviewerAgent.execute(..., { repoDir: '/tmp/repo-shop' }) passes 'repo-shop' as
 *      the fourth argument to buildReviewArtifact
 *   5. ReviewerAgent.execute(..., { repoDir: '/tmp/repo-api' }) passes 'repo-api' —
 *      confirming distinct paths that cannot collide on disk
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../../src/app.module';
import { ReviewerAgent } from '../../src/agents/reviewer.agent';
import { ReviewStageService } from '../../src/workflows/stages/review-stage.service';
import { GitService } from '../../src/integrations/git/git.service';
import { deriveReviewArtifactPath } from '../../src/shared/utils/plan-artifact';
import type { TicketArtifact } from '../../src/agents/interfaces';
import { createReporter } from './support/reporter';

const { counts, pass, fail } = createReporter();

const ticket: TicketArtifact = {
  ticketKey: 'WBP-1',
  content: '# WBP-1',
  path: '/tmp/.wf/WBP-1.md',
};

function checkScopedPath(): void {
  const scopedPath = deriveReviewArtifactPath('/tmp/.wf/WBP-1.md', 'repo-shop');
  if (scopedPath === '/tmp/.wf/WBP-1-repo-shop-review.md') {
    pass('deriveReviewArtifactPath appends -repo-shop-review.md when repoScope is provided');
  } else {
    fail('unexpected scoped path', scopedPath);
  }
}

function checkUnscopedPath(): void {
  const unscopedPath = deriveReviewArtifactPath('/tmp/.wf/WBP-1.md');
  if (unscopedPath === '/tmp/.wf/WBP-1-review.md') {
    pass('deriveReviewArtifactPath appends -review.md when repoScope is absent');
  } else {
    fail('unscoped path regressed', unscopedPath);
  }
}

function checkBuildArtifactScope(reviewStageService: ReviewStageService): void {
  const review = { summary: 'ok', issues: [], suggestions: [], approved: true } as any;
  const artifact = reviewStageService.buildReviewArtifact(ticket, review, undefined, 'repo-api');
  if (artifact.path === '/tmp/.wf/WBP-1-repo-api-review.md') {
    pass('buildReviewArtifact produces -repo-api-review.md path when repoScope is provided');
  } else {
    fail('unexpected buildReviewArtifact path', artifact.path);
  }
}

function checkCapturedScopes(capturedScopes: (string | undefined)[]): void {
  if (capturedScopes[0] === 'repo-shop') {
    pass("execute passes 'repo-shop' as repoScope for repoDir ending in repo-shop");
  } else {
    fail("expected repoScope 'repo-shop' for first call", String(capturedScopes[0]));
  }
  if (capturedScopes[1] === 'repo-api') {
    pass("execute passes 'repo-api' as repoScope for repoDir ending in repo-api");
  } else {
    fail("expected repoScope 'repo-api' for second call", String(capturedScopes[1]));
  }
}

function spyBuildArtifact(
  reviewStageService: ReviewStageService,
  capturedScopes: (string | undefined)[],
): () => void {
  const originalBuild = reviewStageService.buildReviewArtifact.bind(reviewStageService);
  (reviewStageService as any).buildReviewArtifact = (t: unknown, r: unknown, s: unknown, scope?: string) => {
    capturedScopes.push(scope);
    return originalBuild(t as any, r as any, s as any, scope);
  };
  return () => {
    (reviewStageService as any).buildReviewArtifact = originalBuild;
  };
}

function mockGitService(gitService: GitService): () => void {
  const originalGetStatus = gitService.getStatus.bind(gitService);
  const originalStageAll = gitService.stageAll.bind(gitService);
  const originalGetDiff = gitService.getDiff.bind(gitService);
  (gitService as any).getStatus = async () => ({ files: ['src/some.ts'] });
  (gitService as any).stageAll = async () => {};
  (gitService as any).getDiff = async () => 'diff --git a/src/some.ts b/src/some.ts\n';
  return () => {
    (gitService as any).getStatus = originalGetStatus;
    (gitService as any).stageAll = originalStageAll;
    (gitService as any).getDiff = originalGetDiff;
  };
}

interface ScopeCaptureOptions {
  reviewer: ReviewerAgent;
  reviewStageService: ReviewStageService;
  gitService: GitService;
  tempRoot: string;
}

async function runReviewerScopeCapture(opts: ScopeCaptureOptions): Promise<(string | undefined)[]> {
  const { reviewer, reviewStageService, gitService, tempRoot } = opts;
  const capturedScopes: (string | undefined)[] = [];
  const restoreBuild = spyBuildArtifact(reviewStageService, capturedScopes);
  const restoreGit = mockGitService(gitService);
  const repoShopDir = path.join(tempRoot, 'repo-shop');
  const repoApiDir = path.join(tempRoot, 'repo-api');
  fs.mkdirSync(repoShopDir, { recursive: true });
  fs.mkdirSync(repoApiDir, { recursive: true });
  await reviewer.execute(ticket, { repoDir: repoShopDir, silent: true }).catch(() => {});
  await reviewer.execute(ticket, { repoDir: repoApiDir, silent: true }).catch(() => {});
  restoreBuild();
  restoreGit();
  return capturedScopes;
}

async function runChecks(app: any, tempRoot: string): Promise<void> {
  try {
    const reviewStageService = app.get(ReviewStageService);
    const reviewer = app.get(ReviewerAgent);
    const gitService = app.get(GitService);
    checkScopedPath();
    checkUnscopedPath();
    checkBuildArtifactScope(reviewStageService);
    const capturedScopes = await runReviewerScopeCapture({ reviewer, reviewStageService, gitService, tempRoot });
    checkCapturedScopes(capturedScopes);
  } finally {
    await app.close();
  }
}

async function main(): Promise<void> {
  console.log('Smoke: per-repo review artifact path isolation\n');
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-review-iso-'));
  try {
    const app = await NestFactory.createApplicationContext(AppModule, { logger: false });
    await runChecks(app, tempRoot);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
  console.log(`\n${counts.passed} passed, ${counts.failed} failed`);
  if (counts.failed > 0) process.exit(1);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
