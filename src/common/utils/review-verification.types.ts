export type VerificationStatus = 'passed' | 'failed' | 'not-run';
export type VerificationSource = 'reviewed-diff' | 'cached-summary' | 'none';

export interface VerificationCommandResult {
  command: string;
  status: VerificationStatus;
  durationMs: number;
  exitCode?: number;
  signal?: string;
  output?: string;
  reason?: string;
}

export interface ReviewVerification {
  status: VerificationStatus;
  source: VerificationSource;
  repositoryHead?: string;
  packageManager?: string;
  dependencyInstall?: VerificationCommandResult;
  checks: VerificationCommandResult[];
  reason?: string;
}

export interface PreReviewContextResult {
  context: string;
  verification: ReviewVerification;
}
