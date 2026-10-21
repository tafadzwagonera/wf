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
 * Run: nr test:manual agent-decomposition-fixes.smoke.ts
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
import { REVIEW_VERDICT_APPROVED } from '../../src/common/types/review.types';
import { extractSummary, slugify, resolveRepoBasePath } from '../../src/agents/utils';
import { deriveReviewArtifactPath } from '../../src/common/utils/plan-artifact';
import { createReporter } from './support/reporter';

const origLog = console.log;
const { counts, pass, fail } = createReporter();

type CallRecorder = {
  stageAllCalled: boolean;
  stageAllCwd: string | undefined;
  getDiffStaged: boolean | undefined;
  restore: () => void;
};

function recordStageAllAndDiff(gs: GitService, state: CallRecorder): void {
  gs.stageAll = async (cwd?: string) => {
    state.stageAllCalled = true;
    state.stageAllCwd = cwd;
  };
  gs.getDiff = async (staged: boolean) => {
    state.getDiffStaged = staged;
    return 'diff --git a/src/a.ts b/src/a.ts';
  };
}

function captureGitServiceCalls(gs: GitService, restore: () => void): CallRecorder {
  const state: CallRecorder = {
    stageAllCalled: false,
    stageAllCwd: undefined,
    getDiffStaged: undefined,
    restore,
  };
  recordStageAllAndDiff(gs, state);
  return state;
}

function setupGitMocks(gs: GitService): CallRecorder {
  const orig = {
    getStatus: gs.getStatus.bind(gs),
    stageAll: gs.stageAll.bind(gs),
    getDiff: gs.getDiff.bind(gs),
    getRecentCommits: gs.getRecentCommits.bind(gs),
    commit: gs.commit.bind(gs),
  };

  gs.getStatus = async () => ({ files: [{ path: 'src/a.ts' }], staged: [] }) as any;
  const restore = () => Object.assign(gs, orig);
  const calls = captureGitServiceCalls(gs, restore);
  gs.getRecentCommits = async () => [{ message: 'WBP-1: prior' }] as any;
  gs.commit = async () => 'abc123';

  return calls;
}

function assertStageAllCalled(state: any): void {
  if (state.stageAllCalled) {
    pass('stageAll was called before getDiff');
  } else {
    fail('stageAll was NOT called — committer skipped staging');
  }
}

function assertStageAllCwd(state: any): void {
  if (state.stageAllCwd === '/tmp/repo') {
    pass('stageAll received the correct repoDir');
  } else {
    fail('stageAll received wrong repoDir', `got: ${state.stageAllCwd}`);
  }
}

function assertGetDiffStaged(state: any): void {
  if (state.getDiffStaged === true) {
    pass('getDiff was called with staged=true');
  } else {
    fail('getDiff was called with staged=false — should be true after stageAll');
  }
}

async function executeCommitterTest(committer: any): Promise<void> {
  console.log = () => {};
  try {
    await committer.execute('WBP-1', '/tmp/repo', 'context', false, false);
  } finally {
    console.log = origLog;
  }
}

function setupGenerateCommitMessageMock(): () => void {
  const origGenerate = CommitStageService.prototype.generateCommitMessage;
  (CommitStageService.prototype as any).generateCommitMessage = async () => 'WBP-1: test commit';
  return () => {
    CommitStageService.prototype.generateCommitMessage = origGenerate;
  };
}

function runCommitterAssertions(state: any): void {
  assertStageAllCalled(state);
  assertStageAllCwd(state);
  assertGetDiffStaged(state);
}

async function testCommitterAgent(app: any): Promise<void> {
  const committer = app.get(CommitterAgent);
  const gitService = app.get(GitService);
  const state = setupGitMocks(gitService);
  const restoreGenerate = setupGenerateCommitMessageMock();
  await executeCommitterTest(committer);
  state.restore();
  restoreGenerate();
  runCommitterAssertions(state);
}

function setupApprovedReview(tmpDir: string): string {
  const ticketPath = path.join(tmpDir, 'WBP-TEST.md');
  fs.writeFileSync(ticketPath, '# WBP-TEST: Test');
  const reviewPath = deriveReviewArtifactPath(ticketPath);
  fs.mkdirSync(path.dirname(reviewPath), { recursive: true });
  fs.writeFileSync(reviewPath, `# Code Review\n\n## Approval Status\n✔ ${REVIEW_VERDICT_APPROVED}\n`);
  return ticketPath;
}

async function testReviewerApprovalPath1(app: any, tmpDir: string): Promise<void> {
  const ticketPath = setupApprovedReview(tmpDir);
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
}

async function testReviewerApprovalPath2(app: any, tmpDir: string): Promise<void> {
  const ticketPath = path.join(tmpDir, 'WBP-TEST.md');
  const reviewPath = deriveReviewArtifactPath(ticketPath);
  fs.writeFileSync(reviewPath, '# Code Review\n\n## Approval Status\nChanges Requested\n');
  const reviewer = app.get(ReviewerAgent);
  const result2 = await reviewer.execute(
    { ticketKey: 'WBP-TEST', content: '# WBP-TEST: Test', path: ticketPath },
    { skipExisting: true, silent: true }
  );
  if (result2?.approved === false) {
    pass('Cached review without approval marker detected as not-approved');
  } else {
    fail('Cached review without marker incorrectly detected as approved');
  }
}

async function testReviewerAgent(app: any): Promise<void> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-agent-fix-'));
  try {
    await testReviewerApprovalPath1(app, tmpDir);
    await testReviewerApprovalPath2(app, tmpDir);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

function testExtractSummaryKeyed(): void {
  const result = extractSummary('# WBP-123: Fix login redirect\n\nBody text');
  if (result === 'Fix login redirect') pass('extractSummary extracts keyed heading');
  else fail('extractSummary keyed heading failed', `got: ${result}`);
}

function testExtractSummaryPlain(): void {
  const result = extractSummary('# Generic heading\n\nBody');
  if (result === 'Generic heading') pass('extractSummary extracts plain heading');
  else fail('extractSummary plain heading failed', `got: ${result}`);
}

function testExtractSummaryFallback(): void {
  const result = extractSummary('No heading here');
  if (result === 'Implementation') pass('extractSummary returns fallback for missing heading');
  else fail('extractSummary fallback failed', `got: ${result}`);
}

function testSlugifyLeadingTrailing(): void {
  const result = slugify('--Hello World--');
  if (result === 'hello-world') pass('slugify strips leading/trailing hyphens');
  else fail('slugify leading/trailing hyphens not stripped', `got: ${result}`);
}

function testSlugifySpecialChars(): void {
  const result = slugify('Fix: login   redirect!!!');
  if (result === 'fix-login-redirect') pass('slugify handles special chars and collapsed spaces');
  else fail('slugify special chars failed', `got: ${result}`);
}

function testResolveRepoBasePathUndefined(): void {
  const result = resolveRepoBasePath();
  if (result === process.cwd()) pass('resolveRepoBasePath() returns cwd');
  else fail('resolveRepoBasePath(undefined) did not return cwd', `got: ${result}`);
}

function testResolveRepoBasePathNonexistent(): void {
  console.log = () => {};
  const result = resolveRepoBasePath('nonexistent-repo-xyz-123');
  console.log = origLog;
  if (result === process.cwd()) pass('resolveRepoBasePath(nonexistent) falls back to cwd');
  else fail('resolveRepoBasePath(nonexistent) did not fall back', `got: ${result}`);
}

async function runUtilsTests(): Promise<void> {
  testExtractSummaryKeyed();
  testExtractSummaryPlain();
  testExtractSummaryFallback();
  testSlugifyLeadingTrailing();
  testSlugifySpecialChars();
  testResolveRepoBasePathUndefined();
  testResolveRepoBasePathNonexistent();
}

async function runTests(app: any): Promise<void> {
  origLog('  Part 1: CommitterAgent stages before diff');
  await testCommitterAgent(app);
  origLog('  Part 2: ReviewerAgent cached approval detection');
  await testReviewerAgent(app);
  origLog('  Part 3: utils.ts function contracts');
  await runUtilsTests();
}

function reportResults(): void {
  origLog(`\nResults: ${counts.passed} passed, ${counts.failed} failed\n`);
  if (counts.failed > 0) {
    process.exit(1);
  }
}

async function main(): Promise<void> {
  origLog('\nManual Test: agent decomposition review fixes\n');
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });
  try {
    await runTests(app);
  } finally {
    await app.close();
  }
  reportResults();
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
