/**
 * Manual Test: commit description hash guard
 *
 * Run: nr test:manual commit-description-hash-guard.smoke.ts
 *
 * Verifies, against real files in a temp WF_HOME:
 *   1. A sidecar whose diffSha256 matches the staged diff is returned as the scope summary
 *   2. A non-matching staged diff falls through to the regex-scraped review summary
 *   3. The custom-dir sidecar is resolved when reviewArtifactPath is supplied
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { resolveCommitScopeSummary } from '../../src/shared/utils/resolve-commit-scope-summary';
import { resolveCustomReviewArtifactPath, resolveReviewArtifactPath } from '../../src/shared/utils/resolve-review-summary';
import {
  deriveCommitDescriptionPath,
  hashCommitDescriptionDiff,
} from '../../src/shared/utils/commit-description-artifact';
import { createReporter, summarise } from './support/reporter';

const { counts, pass, fail } = createReporter();

const TRACKER_NAME = 'jira';
const TICKET_KEY = 'SMOKE-1';
const PLAN_STEM = 'smoke-plan';
const REVIEW_SUMMARY = 'SCRAPED REVIEW SUMMARY';
const DESCRIPTION = 'Guarded description of the staged change.';
const STAGED_DIFF = 'diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old\n+new';
const OTHER_DIFF = `${STAGED_DIFF}\n+extra`;
const RENDERED_DESCRIPTION = `${DESCRIPTION} (change nature: fix)`;

type ScopeBase = { repoBaseDir: string; trackerName: string; ticketKey: string | null };

const assert = (label: string, condition: boolean, detail?: string): void => {
  if (condition) pass(label);
  else fail(label, detail);
};

const writeReviewWithSidecar = (reviewPath: string): void => {
  fs.mkdirSync(path.dirname(reviewPath), { recursive: true });
  fs.writeFileSync(reviewPath, `## Summary\n${REVIEW_SUMMARY}\n\n## Issues\nNone\n`);
  fs.writeFileSync(
    deriveCommitDescriptionPath(reviewPath),
    JSON.stringify({ nature: 'fix', description: DESCRIPTION, diffSha256: hashCommitDescriptionDiff(STAGED_DIFF) })
  );
};

const checkMatchingDiff = (base: ScopeBase): void => {
  console.log(' Test 1: matching diff returns the description');
  const matched = resolveCommitScopeSummary({ ...base, stagedDiff: STAGED_DIFF });
  assert('returns the rendered description', matched === RENDERED_DESCRIPTION, `got: ${matched}`);
};

const checkMismatchedDiff = (base: ScopeBase): void => {
  console.log(' Test 2: different diff falls back to the scraped review summary');
  const mismatched = resolveCommitScopeSummary({ ...base, stagedDiff: OTHER_DIFF });
  assert('returns the scraped review summary', mismatched === REVIEW_SUMMARY, `got: ${mismatched}`);
};

const checkCustomDirSidecar = (base: ScopeBase): void => {
  console.log(' Test 3: custom-dir sidecar resolves via reviewArtifactPath');
  const customReview = resolveCustomReviewArtifactPath(base.repoBaseDir, PLAN_STEM);
  writeReviewWithSidecar(customReview);
  const custom = resolveCommitScopeSummary({
    ...base, ticketKey: null, stagedDiff: STAGED_DIFF, reviewArtifactPath: customReview,
  });
  assert('returns the custom-dir description', custom === RENDERED_DESCRIPTION, `got: ${custom}`);
};

const createTempRepo = (): { wfHome: string; repoDir: string } => {
  const wfHome = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-hash-guard-'));
  process.env.WF_HOME = wfHome;
  const repoDir = path.join(wfHome, 'repo');
  fs.mkdirSync(repoDir, { recursive: true });
  return { wfHome, repoDir };
};

const main = (): void => {
  const { wfHome, repoDir } = createTempRepo();
  try {
    writeReviewWithSidecar(resolveReviewArtifactPath(repoDir, TRACKER_NAME, TICKET_KEY));
    const base: ScopeBase = { repoBaseDir: repoDir, trackerName: TRACKER_NAME, ticketKey: TICKET_KEY };
    checkMatchingDiff(base);
    checkMismatchedDiff(base);
    checkCustomDirSidecar(base);
  } finally {
    fs.rmSync(wfHome, { recursive: true, force: true });
  }
  summarise(counts);
};

main();
