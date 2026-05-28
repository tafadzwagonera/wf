// src/agents/interfaces.ts
import { CodeReview, ResolutionPlan } from '../integrations/ai/ai.service';
import type { VerificationPolicy } from '../shared/utils/verification-manifest';

/**
 * A resolved verification script entry used by ImplementerAgent and AnthropicAgentAdapter.
 * Moved here from implementer.agent.ts to avoid circular imports.
 */
export interface VerificationScript {
  id: string;
  name: string;
  command: string;
  policy: VerificationPolicy;
  reason?: string;
  aliases: string[];
}

/** Per-file fix instruction produced by the diagnosis phase. */
export interface FixPlanEntry {
  /** Repo-prefixed file path matching filesAffected format (e.g. "repo/src/foo.ts"). */
  file: string;
  /** Why this file needs to change. */
  rationale: string;
  /** Related files the AI should read as context — may come from any known repo. */
  relatedFiles: string[];
}

/**
 * Structured fix plan returned by the diagnosis AI call.
 * Used as shared context for all file re-generations on a retry attempt.
 */
export interface FixPlan {
  summary: string;
  fixes: FixPlanEntry[];
  /** Test assertion context when the failure includes test output. */
  testContext?: string;
  classification?: {
    category: VerificationFailureCategory;
    rootSignal: string;
    strategy: RetryScopeStrategy;
  };
}

export type ImplementBackendName =
  | 'two-phase'
  | 'anthropic-agent'
  | 'openai-agent';

export interface ImplementBackendSelection {
  configured: ImplementBackendName;
  selected: ImplementBackendName;
  provider: string;
  fallbackReason?: string;
}

export type VerificationFailureCategory =
  | 'parse'
  | 'lint'
  | 'typecheck'
  | 'test-compile'
  | 'test-runtime'
  | 'build'
  | 'command'
  | 'unknown';

export type RetryScopeStrategy = 'surgical' | 'paired-files' | 'broad-context';

export interface VerificationFailureClassification {
  category: VerificationFailureCategory;
  implicatedFiles: string[];
  companionFiles: string[];
  rootSignal: string;
  strategy: RetryScopeStrategy;
  confidence: 'high' | 'medium' | 'low';
}

export interface ImplementRunArtifact {
  ticketKey: string;
  repoDir: string;
  backendConfigured: ImplementBackendName;
  backendSelected: ImplementBackendName;
  provider: string;
  fallbackReason?: string;
  verificationScripts: Array<{ id: string; command: string }>;
  startedAt: string;
}

export interface VerificationAttemptArtifact {
  ticketKey: string;
  attemptNumber: number;
  backend: ImplementBackendName;
  command: string;
  exitCode: number;
  failed: boolean;
  classification: VerificationFailureClassification;
  fingerprint: string;
  progress: {
    advancedStage: boolean;
    reducedDiagnostics: boolean;
    narrowedFileSet: boolean;
  };
  retryScope: string[];
  createdAt: string;
}

export type ResolutionAction = 'feature' | 'fix' | 'investigate';

export interface TicketArtifact {
  ticketKey: string;
  content: string;
  path: string;
  fromCache?: boolean;
}

export interface PlanArtifact {
  plan: ResolutionPlan;
  action: ResolutionAction;
  path: string;
  fromCache?: boolean;
}

export interface ReviewArtifact {
  review: CodeReview;
  path: string;
  approved: boolean;
}

export interface FetcherOptions {
  platformName: string;
  repo?: string;
  skipExisting?: boolean;
  baseDir?: string;
}

export interface PlannerOptions {
  action: ResolutionAction;
  skipExisting?: boolean;
  affectedRepositories?: string[];
}

/** Controls how the implement-stage adapter selects its model.
 *  - `auto` — detect mechanical vs creative from the plan, switch mid-run
 *  - `primary` — force the primary model for the entire run
 *  - `mechanical` — force the cheaper mechanical model for the entire run */
export type ModelRouting = 'auto' | 'primary' | 'mechanical';

/** platformName is required to apply Atlassian vs GitHub ticket-key casing rules. */
export interface ImplementerOptions {
  platformName: string;
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
}

export interface ReviewerOptions {
  skipExisting?: boolean;
  repoDir?: string;
  suppressHeader?: boolean;
}

export interface FindingsArtifact {
  action: 'investigate';
  summary: string;
  findings: string[];
  recommendations: string[];
  conclusion: string;
  path: string;
}

export type ImplementerResult =
  | { type: 'implementation'; branchName: string }
  | { type: 'investigation'; artifact: FindingsArtifact };

/**
 * Backend contract for the implementation stage.
 * Both the standard two-phase path and the experimental agent adapter satisfy this.
 * generateAndVerify is called after the branch is already created by execute().
 */
export interface IImplementerBackend {
  generateAndVerify(params: {
    ticket: TicketArtifact;
    planArtifact: PlanArtifact;
    options: ImplementerOptions;
    verificationScripts: VerificationScript[];
    sceneContext: string;
    repoFiles: string[];
    repoName: string;
    trackedFilePaths: string[];
  }): Promise<void>;
}
