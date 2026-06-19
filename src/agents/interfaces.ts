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

export type ImplementBackendName =
  | 'anthropic-agent'
  | 'openai-agent'
  | 'claude-cli';

export interface ImplementBackendSelection {
  configured: ImplementBackendName;
  selected: ImplementBackendName;
  provider: string;
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
}

/** Controls how the implement-stage adapter selects its model.
 *  - `auto` — detect mechanical vs creative from the plan, switch mid-run
 *  - `default` — force the default model for the entire run
 *  - `mechanical` — force the cheaper mechanical model for the entire run */
export type ModelRouting = 'auto' | 'default' | 'mechanical';

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
}

export interface ReviewerOptions {
  skipExisting?: boolean;
  repoDir?: string;
  suppressHeader?: boolean;
  silent?: boolean;
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
 * The Anthropic and OpenAI agent adapters satisfy this contract.
 * generateAndVerify is called after the branch is already created by execute().
 */
export interface ImplementerBackend {
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
