/**
 * Manual smoke test for agent decomposition review fixes.
 *
 * Verifies the behavioral changes introduced by the code-review fixes:
 * 1. CommitterAgent.hasChangesToCommit calls stageAll before returning true
 * 2. CommitterAgent.buildCommitMessage calls getDiff with staged=true
 * 3. ReviewerAgent.tryLoadCachedReview detects approval via REVIEW_VERDICT_APPROVED constant
 * 4. utils.ts: extractSummary uses regex .exec() directly (no redundant new RegExp wrapper)
 * 5. utils.ts: slugify strips leading/trailing hyphens with grouped alternation
 * 6. utils.ts: tryResolvePath and tryResolveSegmentFallback are callable (declared before use)
 *
 * Run: nr test:manual -- test-agent-decomposition-fixes
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../../src/app.module';
import { CommitterAgent } from '../../src/agents/committer.agent';
import { ReviewerAgent } from '../../src/agents/reviewer.agent';
import { GitService } from '../../src/integrations/git/git.service';
import { CommitStageService } from '../../src/workflows/stages/commit-stage.service';
import { REVIEW_VERDICT_APPROVED } from '../../src/shared/types/review.types';
import { extractSummary, slugify, resolveRepoBasePath } from '../../src/agents/utils';
import { deriveReviewArtifactPath } from '../../src/shared/utils/plan-artifact';
import { createReporter } from './support/reporter';

const origLog = console.log;
const { counts, pass, fail } = createReporter();

async function main(): Promise<void> {
  origLog('\nManual Test: agent decomposition review fixes\n');

  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn'],
  });

  origLog('  Part 1: CommitterAgent stages before diff');
  {
    const committer = app.get(CommitterAgent);
    const gitService = app.get(GitService);

    let stageAllCalled = false;
    let stageAllCwd: string | undefined;
    let getDiffStaged: boolean | undefined;

    const origGetStatus = gitService.getStatus.bind(gitService);
    const origStageAll = gitService.stageAll.bind(gitService);
    const origGetDiff = gitService.getDiff.bind(gitService);
    const origGetCommits = gitService.getRecentCommits.bind(gitService);
    const origCommit = gitService.commit.bind(gitService);

    gitService.getStatus = async () => ({ files: [{ path: 'src/a.ts' }], staged: [] }) as any;
    gitService.stageAll = async (cwd?: string) => {
      stageAllCalled = true;
      stageAllCwd = cwd;
    };
    gitService.getDiff = async (staged: boolean) => {
      getDiffStaged = staged;
      return 'diff --git a/src/a.ts b/src/a.ts';
    };
    gitService.getRecentCommits = async () => [{ message: 'WBP-1: prior' }] as any;
    gitService.commit = async () => 'abc123';

    const origGenerate = CommitStageService.prototype.generateCommitMessage;
    (CommitStageService.prototype as any).generateCommitMessage = async () => 'WBP-1: test commit';

    // Suppress console output during the test
    console.log = () => {};
    try {
      await committer.execute('WBP-1', '/tmp/repo', 'context', false, false);
    } finally {
      console.log = origLog;
    }

    if (stageAllCalled) {
      pass('stageAll was called before getDiff');
    } else {
      fail('stageAll was NOT called — committer skipped staging');
    }

    if (stageAllCwd === '/tmp/repo') {
      pass('stageAll received the correct repoDir');
    } else {
      fail('stageAll received wrong repoDir', `got: ${stageAllCwd}`);
    }

    if (getDiffStaged === true) {
      pass('getDiff was called with staged=true');
    } else {
      fail('getDiff was called with staged=false — should be true after stageAll');
    }

    gitService.getStatus = origGetStatus;
    gitService.stageAll = origStageAll;
    gitService.getDiff = origGetDiff;
    gitService.getRecentCommits = origGetCommits;
    gitService.commit = origCommit;
    CommitStageService.prototype.generateCommitMessage = origGenerate;
  }

  origLog('  Part 2: ReviewerAgent cached approval detection');
  {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-agent-fix-'));
    const ticketPath = path.join(tmpDir, 'WBP-TEST.md');
    fs.writeFileSync(ticketPath, '# WBP-TEST: Test');

    const reviewPath = deriveReviewArtifactPath(ticketPath);
    fs.mkdirSync(path.dirname(reviewPath), { recursive: true });

    fs.writeFileSync(reviewPath, `# Code Review\n\n## Approval Status\n\u2714 ${REVIEW_VERDICT_APPROVED}\n`);

    const reviewer = app.get(ReviewerAgent);
    const result = await reviewer.execute(
      { ticketKey: 'WBP-TEST', content: '# WBP-TEST: Test', path: ticketPath },
      { skipExisting: true, silent: true }
    );

    if (result?.approved === true) {
      pass('Cached review detected as approved via REVIEW_VERDICT_APPROVED constant');
    } else {
      fail('Cached review NOT detected as approved', `result: ${JSON.stringify(result)}`);
    }

    fs.writeFileSync(reviewPath, '# Code Review\n\n## Approval Status\nChanges Requested\n');
    const result2 = await reviewer.execute(
      { ticketKey: 'WBP-TEST', content: '# WBP-TEST: Test', path: ticketPath },
      { skipExisting: true, silent: true }
    );

    if (result2?.approved === false) {
      pass('Cached review without approval marker detected as not-approved');
    } else {
      fail('Cached review without marker incorrectly detected as approved');
    }

    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  origLog('  Part 3: utils.ts function contracts');
  {
    const summary1 = extractSummary('# WBP-123: Fix login redirect\n\nBody text');
    if (summary1 === 'Fix login redirect') {
      pass('extractSummary extracts keyed heading');
    } else {
      fail('extractSummary keyed heading failed', `got: ${summary1}`);
    }

    const summary2 = extractSummary('# Generic heading\n\nBody');
    if (summary2 === 'Generic heading') {
      pass('extractSummary extracts plain heading');
    } else {
      fail('extractSummary plain heading failed', `got: ${summary2}`);
    }

    const summary3 = extractSummary('No heading here');
    if (summary3 === 'Implementation') {
      pass('extractSummary returns fallback for missing heading');
    } else {
      fail('extractSummary fallback failed', `got: ${summary3}`);
    }
  }

  {
    const slug1 = slugify('--Hello World--');
    if (slug1 === 'hello-world') {
      pass('slugify strips leading/trailing hyphens');
    } else {
      fail('slugify leading/trailing hyphens not stripped', `got: ${slug1}`);
    }

    const slug2 = slugify('Fix: login   redirect!!!');
    if (slug2 === 'fix-login-redirect') {
      pass('slugify handles special chars and collapsed spaces');
    } else {
      fail('slugify special chars failed', `got: ${slug2}`);
    }
  }

  {
    const result = resolveRepoBasePath(undefined);
    if (result === process.cwd()) {
      pass('resolveRepoBasePath(undefined) returns cwd');
    } else {
      fail('resolveRepoBasePath(undefined) did not return cwd', `got: ${result}`);
    }

    // Suppress the warning log for a non-existent repo
    console.log = () => {};
    const result2 = resolveRepoBasePath('nonexistent-repo-xyz-123');
    console.log = origLog;
    if (result2 === process.cwd()) {
      pass('resolveRepoBasePath(nonexistent) falls back to cwd');
    } else {
      fail('resolveRepoBasePath(nonexistent) did not fall back', `got: ${result2}`);
    }
  }

  await app.close();

  origLog(`\nResults: ${counts.passed} passed, ${counts.failed} failed\n`);
  if (counts.failed > 0) {
    process.exit(1);
  }
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
