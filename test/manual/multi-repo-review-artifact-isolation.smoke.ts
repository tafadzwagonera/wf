/**
 * Smoke test: per-repo review artifact paths are distinct in a multi-repo run
 *
 * Run: nr test:manual -- multi-repo-review-artifact-isolation
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

async function main(): Promise<void> {
  console.log('Smoke: per-repo review artifact path isolation\n');

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-review-iso-'));

  try {
    const app = await NestFactory.createApplicationContext(AppModule, { logger: false });

    try {
      const reviewStageService = app.get(ReviewStageService);
      const reviewer = app.get(ReviewerAgent);
      const gitService = app.get(GitService);

      // 1. deriveReviewArtifactPath with scope
      const scopedPath = deriveReviewArtifactPath('/tmp/.wf/WBP-1.md', 'repo-shop');
      if (scopedPath === '/tmp/.wf/WBP-1-repo-shop-review.md') {
        pass('deriveReviewArtifactPath appends -repo-shop-review.md when repoScope is provided');
      } else {
        fail('unexpected scoped path', scopedPath);
      }

      // 2. deriveReviewArtifactPath without scope (regression guard)
      const unscopedPath = deriveReviewArtifactPath('/tmp/.wf/WBP-1.md');
      if (unscopedPath === '/tmp/.wf/WBP-1-review.md') {
        pass('deriveReviewArtifactPath appends -review.md when repoScope is absent');
      } else {
        fail('unscoped path regressed', unscopedPath);
      }

      // 3. buildReviewArtifact with repoScope
      const review = { summary: 'ok', issues: [], suggestions: [], approved: true } as any;
      const artifact = reviewStageService.buildReviewArtifact(ticket, review, undefined, 'repo-api');
      if (artifact.path === '/tmp/.wf/WBP-1-repo-api-review.md') {
        pass('buildReviewArtifact produces -repo-api-review.md path when repoScope is provided');
      } else {
        fail('unexpected buildReviewArtifact path', artifact.path);
      }

      // 4–5. ReviewerAgent.execute passes the repo basename as repoScope
      const capturedScopes: (string | undefined)[] = [];
      const originalBuild = reviewStageService.buildReviewArtifact.bind(reviewStageService);
      (reviewStageService as any).buildReviewArtifact = (
        t: unknown, r: unknown, s: unknown, scope?: string
      ) => {
        capturedScopes.push(scope);
        return originalBuild(t as any, r as any, s as any, scope);
      };

      const originalGetStatus = gitService.getStatus.bind(gitService);
      (gitService as any).getStatus = async () => ({ files: ['src/some.ts'] });
      const originalStageAll = gitService.stageAll.bind(gitService);
      (gitService as any).stageAll = async () => {};
      const originalGetDiff = gitService.getDiff.bind(gitService);
      (gitService as any).getDiff = async () => 'diff --git a/src/some.ts b/src/some.ts\n';

      const repoShopDir = path.join(tempRoot, 'repo-shop');
      const repoApiDir = path.join(tempRoot, 'repo-api');
      fs.mkdirSync(repoShopDir, { recursive: true });
      fs.mkdirSync(repoApiDir, { recursive: true });

      await reviewer.execute(ticket, { repoDir: repoShopDir, silent: true }).catch(() => {});
      await reviewer.execute(ticket, { repoDir: repoApiDir, silent: true }).catch(() => {});

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

      (reviewStageService as any).buildReviewArtifact = originalBuild;
      (gitService as any).getStatus = originalGetStatus;
      (gitService as any).stageAll = originalStageAll;
      (gitService as any).getDiff = originalGetDiff;
    } finally {
      await app.close();
    }
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
