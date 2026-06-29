import type {
  VerificationScript,
  ResolutionAction,
  TicketArtifact,
  PlanArtifact,
  ModelRouting,
  FindingsArtifact,
} from '../shared/types/agent.types';

export type {
  VerificationScript,
  ImplementBackendName,
  ImplementBackendSelection,
  VerificationFailureCategory,
  RetryScopeStrategy,
  VerificationFailureClassification,
  ImplementRunArtifact,
  VerificationAttemptArtifact,
  ResolutionAction,
  TicketArtifact,
  PlanArtifact,
  ReviewArtifact,
  ModelRouting,
  FindingsArtifact,
} from '../shared/types/agent.types';

export type ImplementerResult =
  | { type: 'implementation'; branchName: string | null }
  | { type: 'investigation'; artifact: FindingsArtifact };

export interface FetcherOptions {
  trackerName: string;
  repo?: string;
  skipExisting?: boolean;
  baseDir?: string;
  silent?: boolean;
}

export interface PlannerOptions {
  action: ResolutionAction;
  skipExisting?: boolean;
  affectedRepositories?: string[];
  silent?: boolean;
  onProgress?: (line: string) => void;
}

/** trackerName is required to apply Atlassian vs GitHub ticket-key casing rules. */
export interface ImplementerOptions {
  trackerName: string;
  repoDir?: string;
  /** Sibling repository directories available for cross-repo file reads.
   *  Writes always stay within repoDir. Populated from --repos options. */
  additionalRepoDirs?: string[];
  suppressHeader?: boolean;
  conversationContext?: string;
  customBranchSlug?: string;
  /** When true, skips single-repo boundary guards. Set only by IssueCommand's per-repo loop. */
  allowMultiRepoScope?: boolean;
  /** Controls model selection strategy for the implement stage. Defaults to 'auto'. */
  modelRouting?: ModelRouting;
  /** Suppress interactive prompts; auto-select defaults while preserving decorative output. */
  silent?: boolean;
  /** Suppress branch creation; work directly on the source branch. */
  noBranch?: boolean;
  /** CLI override for branch name validation regex (git.branchNamePattern config). */
  branchNamePattern?: string;
  /** Summary from a prior workflow stage (e.g. plan) injected as background context. */
  priorStageSummary?: string;
}

export interface ReviewerOptions {
  skipExisting?: boolean;
  repoDir?: string;
  suppressHeader?: boolean;
  silent?: boolean;
}

/**
 * Backend contract for the implementation stage.
 * The Anthropic and OpenAI agent adapters satisfy this contract.
 * generateAndVerify is called after the branch is already created by execute().
 */
export interface ImplementerBackend {
  generateAndVerify(params: {
    ticket: TicketArtifact;
    planArtifact: PlanArtifact;
    options: ImplementerOptions;
    verificationScripts: VerificationScript[];
    ticketContext: string;
    repoFiles: string[];
    contextFiles?: string[];
    repoName: string;
    trackedFilePaths: string[];
  }): Promise<void>;
}
