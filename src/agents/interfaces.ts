import type {
  ResolutionAction,
  FindingsArtifact,
  TicketArtifact,
  PlanArtifact,
  ImplementerOptions,
  VerificationScript,
  VerificationOutcome,
} from '../shared/types/agent.types';
import type { StepVerificationSummary } from '../shared/types/step-verification.types';

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
  = | {
    type: 'implementation'; hasChanges: boolean; branchName: string | null; sessionId?: string;
    verificationOutcomes: VerificationOutcome[]; passCount?: number; modelsUsed?: string[];
    stepVerification?: StepVerificationSummary;
  }
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
  repoDir?: string;
  silent?: boolean;
  sourceKind?: 'ticket' | 'custom';
  onProgress?: (line: string) => void;
  uiDesignScreenshots?: string[];
  figma?: boolean;
}

export interface ReviewerOptions {
  skipExisting?: boolean;
  repoDir?: string;
  suppressHeader?: boolean;
  silent?: boolean;
  resumeProviderSessionId?: string;
  priorStageSummary?: string;
  forkSession?: boolean;
  onProgress?: (line: string) => void;
  estimatedComplexity?: string;
  passCount?: number;
  /** Force the SonarQube scan on, overriding `stages.review.sonar` config (CLI `--sonar`). */
  sonar?: boolean;
  /** Force the Figma design-conformance check on, overriding `stages.review.figma` config (CLI `--figma`). */
  figma?: boolean;
  /** Tracker name (e.g. 'jira') used to locate plan manifests stored under tracker-namespaced artifact dirs. */
  trackerName?: string;
  /** Absolute path to the plan JSON artifact; used to locate the `.sources.json` manifest for Figma links. */
  planArtifactPath?: string;
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
    repoFiles: string[];
    contextFiles?: string[];
    repoName: string;
    trackedFilePaths: string[];
    conventionsSection?: string;
    skillNames?: string[];
    figmaContextSection?: string;
    uiDesignScreenshotPaths?: string[];
  }): Promise<{
    sessionId?: string;
    verificationOutcomes: VerificationOutcome[];
    passCount?: number;
    /** Models the backend actually ran with; omitted by backends that do not route per run. */
    modelsUsed?: string[];
  }>;
}
