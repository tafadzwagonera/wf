import * as path from 'node:path';
import { resolveVerificationSummary } from './implement-verification';
import { detectRepoConventions, formatRepoConventionsPromptSection } from './detect-repo-conventions';
import { runPreReviewVerification } from './run-pre-review-verification';

export interface PreReviewContextTarget {
  context: string;
  repoDir?: string;
  commentRef?: string;
}

export const buildPreReviewContext = async (
  target: PreReviewContextTarget,
  options: { ticketKey?: string; silent?: boolean } = {}
): Promise<string> => {
  const { repoDir, context } = target;
  if (!repoDir) return context;
  const prVerifySummary = target.commentRef
    ? await runPreReviewVerification(repoDir, { silent: options.silent })
    : '';
  const cachedSummary = resolveVerificationSummary(repoDir, options.ticketKey ?? '');
  const verifySummary = prVerifySummary || cachedSummary;
  const conventions = detectRepoConventions(repoDir);
  const conventionsSection = formatRepoConventionsPromptSection(conventions, path.basename(repoDir));
  const extra = [verifySummary, conventionsSection].filter(Boolean).join('\n\n');
  return extra ? `${context}\n\n${extra}` : context;
};
