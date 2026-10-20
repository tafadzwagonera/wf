import * as path from 'node:path';
import { appendToLogFile } from '../logger/log-file-writer';
import {
  deriveCommitDescriptionPath,
  hashCommitDescriptionDiff,
  readCommitDescriptionRecord,
  renderCommitDescriptionContext,
} from './commit-description-artifact';
import { findExistingReviewArtifact, readReviewArtifactSummary, resolveReviewArtifactPath } from './resolve-review-summary';
import { detectPriorPlans } from './detect-prior-plans';

export interface ResolveCommitScopeSummaryOptions {
  repoBaseDir: string;
  trackerName: string;
  ticketKey: string | null;
  knownPlanSummary?: string;
  stagedDiff?: string;
  reviewArtifactPath?: string;
}

/**
 * Resolve the scope summary for a commit using a tiered lookup strategy.
 *
 * Tier 0: Use the diff-grounded commit description saved beside the review artifact,
 *         only when its sha256 matches the exact `stagedDiff`
 * Tier 1: Check for an existing code review artifact summary
 * Tier 2: Use the caller-supplied `knownPlanSummary` — the authoritative plan
 *         already resolved for this run (via its plan token), if any
 * Tier 3: Fall back to a matching plan from prior plans on disk (by ticketKey),
 *         used only when the caller has no plan already resolved in memory
 * Tier 4: Return null to indicate caller should use diff-only generation
 *
 * This function is synchronous and never throws.
 *
 * @param options.repoBaseDir - Base directory of the repository
 * @param options.trackerName - Tracker namespace (e.g., 'jira', 'bitbucket')
 * @param options.ticketKey - Ticket identifier (e.g., 'WBP-123'), or null/empty for no lookup
 * @param options.knownPlanSummary - Summary of the plan artifact already resolved for this run, if any
 * @param options.stagedDiff - Staged diff the commit will be generated from; enables Tier 0
 * @param options.reviewArtifactPath - Explicit review artifact path that overrides the tracker-derived one
 * @returns Summary text from description, review, or plan, or null if none available
 */
export const resolveCommitScopeSummary = (options: ResolveCommitScopeSummaryOptions): string | null => {
  const { repoBaseDir, trackerName, ticketKey, knownPlanSummary, stagedDiff, reviewArtifactPath } = options;
  if (!ticketKey && !reviewArtifactPath) return null;
  const defaultPath = reviewArtifactPath ?? resolveReviewArtifactPath(repoBaseDir, trackerName, ticketKey as string);
  const effectivePath = findExistingReviewArtifact(defaultPath) ?? defaultPath;
  const tierZero = resolveFreshCommitDescription(effectivePath, stagedDiff);
  if (tierZero) return tierZero;
  const reviewSummary = readReviewArtifactSummary(effectivePath);
  if (reviewSummary) return reviewSummary;
  if (knownPlanSummary && knownPlanSummary.length > 0) return knownPlanSummary;
  if (!ticketKey) return null;
  const repoName = path.basename(path.resolve(repoBaseDir));
  const matchingPlan = detectPriorPlans(repoName).plans.find(p => p.ticketKey === ticketKey);
  return matchingPlan?.summary && matchingPlan.summary.length > 0 ? matchingPlan.summary : null;
};

export const resolveFreshCommitDescription = (reviewPath: string, stagedDiff: string | undefined): string | null => {
  if (!stagedDiff?.trim()) return null;
  const record = readCommitDescriptionRecord(deriveCommitDescriptionPath(reviewPath));
  if (!record) return null;
  if (record.diffSha256 === hashCommitDescriptionDiff(stagedDiff)) return renderCommitDescriptionContext(record);
  appendToLogFile('DEBUG', `commit-description.stale path=${reviewPath}`, 'commit-scope');
  return null;
};
