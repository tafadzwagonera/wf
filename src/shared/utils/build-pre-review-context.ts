import * as path from 'node:path';
import { resolveVerificationSummary } from './implement-verification';
import { detectRepoConventions, formatRepoConventionsPromptSection } from './detect-repo-conventions';
import { runPreReviewVerification } from './run-pre-review-verification';
import type { PreReviewContextResult, ReviewVerification } from './review-verification.types';

export interface PreReviewContextTarget {
  context: string;
  diff: string;
  repoDir?: string;
  commentRef?: string;
  repoCount?: number;
}

interface PreReviewContextOptions {
  ticketKey?: string;
  silent?: boolean;
  skipVerification?: boolean;
}

const cachedVerification = (
  repoDir: string, ticketKey: string
): { summary: string; verification: ReviewVerification } => {
  const summary = resolveVerificationSummary(repoDir, ticketKey);
  return {
    summary,
    verification: {
      status: 'not-run', source: summary ? 'cached-summary' : 'none', checks: [],
      reason: summary
        ? 'Live verification was not eligible; using cached verification summary.'
        : 'Live verification was not eligible.',
    },
  };
};

const resolveVerification = async (repoDir: string, target: PreReviewContextTarget,
  options: PreReviewContextOptions): Promise<{ summary: string; verification: ReviewVerification }> => {
  if (options.skipVerification) {
    return { summary: '', verification: { status: 'not-run', source: 'none', checks: [], reason: 'Verification was skipped with --skip-verification.' } };
  }
  if (target.repoCount && target.repoCount > 1) {
    const cached = cachedVerification(repoDir, options.ticketKey ?? '');
    return { ...cached, verification: { ...cached.verification, reason: 'Verification does not support multi-repository targets.' } };
  }
  if (!target.commentRef && target.repoCount !== 1) return cachedVerification(repoDir, options.ticketKey ?? '');
  const verification = await runPreReviewVerification(repoDir, {
    diff: target.diff, silent: options.silent, skipVerification: false,
  });
  return { summary: '', verification };
};

export const buildPreReviewContext = async (
  target: PreReviewContextTarget, options: PreReviewContextOptions = {}
): Promise<PreReviewContextResult> => {
  const { repoDir, context } = target;
  if (!repoDir) {
    return { context, verification: { status: 'not-run', source: 'none', checks: [], reason: 'No local repository is available for verification.' } };
  }
  const { summary: verifySummary, verification } = await resolveVerification(repoDir, target, options);
  const conventions = detectRepoConventions(repoDir);
  const conventionsSection = formatRepoConventionsPromptSection(conventions, path.basename(repoDir));
  const extra = [verifySummary, conventionsSection].filter(Boolean).join('\n\n');
  return { context: extra ? `${context}\n\n${extra}` : context, verification };
};
