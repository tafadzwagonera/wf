import * as path from 'node:path';
import { readReviewArtifactSummary, resolveReviewArtifactPath } from './resolve-review-summary';
import { detectPriorPlans } from './detect-prior-plans';

/**
 * Resolve the scope summary for a commit using a tiered lookup strategy.
 *
 * Tier 1: Check for an existing code review artifact summary
 * Tier 2: Use the caller-supplied `knownPlanSummary` — the authoritative plan
 *         already resolved for this run (via its plan token), if any
 * Tier 3: Fall back to a matching plan from prior plans on disk (by ticketKey),
 *         used only when the caller has no plan already resolved in memory
 * Tier 4: Return null to indicate caller should use diff-only generation
 *
 * This function is synchronous and never throws.
 *
 * @param repoBaseDir - Base directory of the repository
 * @param trackerName - Tracker namespace (e.g., 'jira', 'bitbucket')
 * @param ticketKey - Ticket identifier (e.g., 'WBP-123'), or null/empty for no lookup
 * @param knownPlanSummary - Summary of the plan artifact already resolved for this run, if any
 * @returns Summary text from review or plan, or null if none available
 */
export const resolveCommitScopeSummary = (
  repoBaseDir: string, trackerName: string, ticketKey: string | null, knownPlanSummary?: string
): string | null => {
  if (!ticketKey) return null;
  const reviewSummary = readReviewArtifactSummary(resolveReviewArtifactPath(repoBaseDir, trackerName, ticketKey));
  if (reviewSummary) return reviewSummary;
  if (knownPlanSummary && knownPlanSummary.length > 0) return knownPlanSummary;
  const repoName = path.basename(path.resolve(repoBaseDir));
  const matchingPlan = detectPriorPlans(repoName).plans.find(p => p.ticketKey === ticketKey);
  return matchingPlan?.summary && matchingPlan.summary.length > 0 ? matchingPlan.summary : null;
};
