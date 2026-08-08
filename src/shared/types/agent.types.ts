import type { z } from 'zod';
import type {
  agentStageNameSchema,
  buildPlanContextParamsSchema,
  buildTaskBriefParamsSchema,
  findingsArtifactSchema,
  implementBackendNameSchema,
  implementBackendSelectionSchema,
  implementRunArtifactSchema,
  implementerOptionsSchema,
  modelRoutingSchema,
  planArtifactSchema,
  resolutionActionSchema,
  retryScopeStrategySchema,
  reviewArtifactSchema,
  ticketArtifactSchema,
  verificationAttemptArtifactSchema,
  verificationFailureCategorySchema,
  verificationFailureClassificationSchema,
  verificationScriptSchema,
} from '../schemas/agent.schema';
import type { verificationOutcomeSchema } from '../schemas/verification.schema';

export type AgentStageName = z.infer<typeof agentStageNameSchema>;
export type FindingsArtifact = z.infer<typeof findingsArtifactSchema>;
export type ImplementBackendName = z.infer<typeof implementBackendNameSchema>;
export type ImplementBackendSelection = z.infer<typeof implementBackendSelectionSchema>;
export type ImplementerOptions = z.infer<typeof implementerOptionsSchema>;
export type ImplementRunArtifact = z.infer<typeof implementRunArtifactSchema>;
export type ModelRouting = z.infer<typeof modelRoutingSchema>;
export type PlanArtifact = z.infer<typeof planArtifactSchema>;
export type ResolutionAction = z.infer<typeof resolutionActionSchema>;
export type RetryScopeStrategy = z.infer<typeof retryScopeStrategySchema>;
export type ReviewArtifact = z.infer<typeof reviewArtifactSchema>;
export type StageProgressCallback = (line: string) => void;
export type TicketArtifact = z.infer<typeof ticketArtifactSchema>;
export type VerificationAttemptArtifact = z.infer<typeof verificationAttemptArtifactSchema>;
export type VerificationFailureCategory = z.infer<typeof verificationFailureCategorySchema>;
export type VerificationFailureClassification = z.infer<typeof verificationFailureClassificationSchema>;
export type VerificationScript = z.infer<typeof verificationScriptSchema>;
export type VerificationOutcome = z.infer<typeof verificationOutcomeSchema>;
export type BuildTaskBriefParams = z.infer<typeof buildTaskBriefParamsSchema>;
export type BuildPlanContextParams = z.infer<typeof buildPlanContextParamsSchema>;
