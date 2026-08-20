import * as path from 'node:path';
import { resolveVerificationSummary } from './implement-verification';
import { detectRepoConventions, formatRepoConventionsPromptSection } from './detect-repo-conventions';
import { runPreReviewVerification } from './run-pre-review-verification';

export interface PreReviewContextTarget {
  context: string;
  repoDir?: string;
  commentRef?: string;
}

interface PreReviewContextOptions {
  ticketKey?: string;
  silent?: boolean;
  skipVerification?: boolean;
}

const resolveVerifySummary = async (
  repoDir: string, target: PreReviewContextTarget, options: PreReviewContextOptions
): Promise<string> => {
  const prSummary = target.commentRef
    ? await runPreReviewVerification(repoDir, { silent: options.silent, skipVerification: options.skipVerification })
    : '';
  return prSummary || resolveVerificationSummary(repoDir, options.ticketKey ?? '');
};

export const buildPreReviewContext = async (
  target: PreReviewContextTarget, options: PreReviewContextOptions = {}
): Promise<string> => {
  const { repoDir, context } = target;
  if (!repoDir) return context;
  const verifySummary = await resolveVerifySummary(repoDir, target, options);
  const conventions = detectRepoConventions(repoDir);
  const conventionsSection = formatRepoConventionsPromptSection(conventions, path.basename(repoDir));
  const extra = [verifySummary, conventionsSection].filter(Boolean).join('\n\n');
  return extra ? `${context}\n\n${extra}` : context;
};
