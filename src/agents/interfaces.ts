import type {
  ResolutionAction,
  FindingsArtifact,
  TicketArtifact,
  PlanArtifact,
  ImplementerOptions,
  VerificationScript,
  VerificationOutcome,
} from '../shared/types/agent.types';

export type {
  VerificationScript,
  VerificationOutcome,
  ImplementBackendName,
  ImplementBackendSelection,
  VerificationFailureCategory,
  RetryScopeStrategy,
  VerificationFailureClassification,
  ImplementerOptions,
  ImplementRunArtifact,
  VerificationAttemptArtifact,
  ResolutionAction,
  TicketArtifact,
  PlanArtifact,
  ReviewArtifact,
  ModelRouting,
  FindingsArtifact,
} from '../shared/types/agent.types';

export type ImplementerResult
  = | { type: 'implementation'; branchName: string | null; sessionId?: string; verificationOutcomes: VerificationOutcome[] }
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

export interface ReviewerOptions {
  skipExisting?: boolean;
  repoDir?: string;
  suppressHeader?: boolean;
  silent?: boolean;
  resumeProviderSessionId?: string;
  priorStageSummary?: string;
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
  }): Promise<{ sessionId?: string; verificationOutcomes: VerificationOutcome[] }>;
}
