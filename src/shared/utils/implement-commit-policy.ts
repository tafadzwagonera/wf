export type CommitComplexity = 'low' | 'medium' | 'high';

export type CommitPolicy = {
  allowsCommit: boolean;
  complexity: CommitComplexity;
};

const OVERRIDE_CLAUSE
  = 'This overrides any conflicting commit guidance in the repository\'s own agent instructions.';

/**
 * Resolves whether the implement stage may commit its own work, based on the
 * plan's estimated complexity. Unknown or missing values fail closed (high).
 *
 * @param complexity - `estimatedComplexity` from the resolution plan
 * @returns The resolved commit policy
 */
export const resolveCommitPolicy = (complexity: string | undefined): CommitPolicy => {
  if (complexity === 'low') return { allowsCommit: true, complexity: 'low' };
  if (complexity === 'medium') return { allowsCommit: false, complexity: 'medium' };
  if (complexity === 'high') return { allowsCommit: false, complexity: 'high' };
  return { allowsCommit: false, complexity: 'high' };
};

/**
 * Formats the commit policy as a prompt section instructing the implement
 * agent whether it may create git commits.
 *
 * @param policy - Resolved commit policy
 * @returns Prompt text to append to the implement stage's conventions section
 */
export const formatCommitPolicyPromptSection = (policy: CommitPolicy): string => {
  if (!policy.allowsCommit) {
    return `Commit policy: this change is estimated **${policy.complexity}** complexity. `
      + 'Do NOT create git commits and do NOT run `git commit`. Leave your work in the working tree '
      + `— a separate review stage inspects the diff before it is committed. ${OVERRIDE_CLAUSE}`;
  }
  return `Commit policy: this change is estimated **${policy.complexity}** complexity. `
    + `You MAY create a git commit for this change. ${OVERRIDE_CLAUSE}`;
};
