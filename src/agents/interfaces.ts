import type {
  ResolutionAction,
  FindingsArtifact,
  TicketArtifact,
  PlanArtifact,
  ImplementerOptions,
  ProviderSessionIdCallback,
  VerificationScript,
  VerificationOutcome,
  PlanProblem,
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
  PlanProblem,
} from '../shared/types/agent.types';

export type ImplementerResult
  = | {
    type: 'implementation'; hasChanges: boolean; branchName: string | null; sessionId?: string;
    verificationOutcomes: VerificationOutcome[]; passCount?: number; modelsUsed?: string[];
    stepVerification?: StepVerificationSummary;
    planProblems?: PlanProblem[];
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
  onProviderSessionId?: ProviderSessionIdCallback;
  estimatedComplexity?: string;
  passCount?: number;
  sonar?: boolean;
  figma?: boolean;
  commentPolicy?: boolean;
  trackerName?: string;
  planArtifactPath?: string;
  commitDescriptionPath?: string;
}

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
    verificationPassOffset?: number;
  }): Promise<{
    sessionId?: string;
    verificationOutcomes: VerificationOutcome[];
    passCount?: number;
    modelsUsed?: string[];
    verificationPassCount?: number;
    planProblems?: PlanProblem[];
  }>;
}
