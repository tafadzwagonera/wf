import { z } from 'zod';
import { verificationPolicySchema } from './verification.schema';
import { planPhaseSchema, resolutionPlanSchema } from './ai.schema';
import { codeReviewSchema } from './review.schema';

export const verificationScriptSchema = z.object({
  id: z.string(),
  name: z.string(),
  command: z.string(),
  policy: verificationPolicySchema,
  reason: z.string().optional(),
  aliases: z.array(z.string()),
});

export const implementBackendNameSchema = z.enum(['anthropic-agent', 'openai-agent', 'claude-cli', 'codex-cli']);

export const implementBackendSelectionSchema = z.object({
  configured: implementBackendNameSchema,
  selected: implementBackendNameSchema,
  provider: z.string(),
});

export const verificationFailureCategorySchema = z.enum([
  'parse',
  'lint',
  'typecheck',
  'test-compile',
  'test-runtime',
  'build',
  'command',
  'unknown',
]);

export const retryScopeStrategySchema = z.enum(['surgical', 'paired-files', 'broad-context']);

export const verificationFailureClassificationSchema = z.object({
  category: verificationFailureCategorySchema,
  implicatedFiles: z.array(z.string()),
  companionFiles: z.array(z.string()),
  rootSignal: z.string(),
  strategy: retryScopeStrategySchema,
  confidence: z.enum(['high', 'medium', 'low']),
});

export const implementRunArtifactSchema = z.object({
  ticketKey: z.string(),
  repoDir: z.string(),
  backendConfigured: implementBackendNameSchema,
  backendSelected: implementBackendNameSchema,
  provider: z.string(),
  verificationScripts: z.array(
    z.object({
      id: z.string(),
      command: z.string(),
    })
  ),
  startedAt: z.string(),
});

export const verificationAttemptArtifactSchema = z.object({
  ticketKey: z.string(),
  attemptNumber: z.number(),
  backend: implementBackendNameSchema,
  command: z.string(),
  exitCode: z.number(),
  failed: z.boolean(),
  classification: verificationFailureClassificationSchema,
  fingerprint: z.string(),
  progress: z.object({
    advancedStage: z.boolean(),
    reducedDiagnostics: z.boolean(),
    narrowedFileSet: z.boolean(),
  }),
  retryScope: z.array(z.string()),
  createdAt: z.string(),
});

export const resolutionActionSchema = z.enum(['feature', 'fix', 'investigate']);

export const ticketArtifactSchema = z.object({
  ticketKey: z.string(),
  content: z.string(),
  path: z.string(),
  fromCache: z.boolean().optional(),
});

export const planArtifactSchema = z.object({
  plan: resolutionPlanSchema,
  action: resolutionActionSchema,
  path: z.string(),
  fromCache: z.boolean().optional(),
  sessionId: z.string().optional(),
});

export const reviewArtifactSchema = z.object({
  review: codeReviewSchema,
  path: z.string(),
  approved: z.boolean(),
  sessionId: z.string().optional(),
});

export const modelRoutingSchema = z.enum(['auto', 'default', 'mechanical']);

export const findingsArtifactSchema = z.object({
  action: z.literal('investigate'),
  summary: z.string(),
  findings: z.array(z.string()),
  recommendations: z.array(z.string()),
  conclusion: z.string(),
  path: z.string(),
});

export const implementerOptionsSchema = z.object({
  trackerName: z.string(),
  repoDir: z.string().optional(),
  additionalRepoDirs: z.array(z.string()).optional(),
  suppressHeader: z.boolean().optional(),
  conversationContext: z.string().optional(),
  customBranchSlug: z.string().optional(),
  allowMultiRepoScope: z.boolean().optional(),
  modelRouting: modelRoutingSchema.optional(),
  silent: z.boolean().optional(),
  noBranch: z.boolean().optional(),
  branchNamePattern: z.string().optional(),
  priorStageSummary: z.string().optional(),
  resumeProviderSessionId: z.string().optional(),
  isNewRepo: z.boolean().optional(),
  initialPromptOverride: z.string().optional(),
  /** Force the Figma implementation skill on, overriding `stages.implement.figma` config (CLI `--figma`). */
  figma: z.boolean().optional(),
  /** Skip post-pull dependency install (use when node_modules is known-clean). */
  skipInstall: z.boolean().optional(),
});

export const agentStageNameSchema = z.enum(['plan', 'review', 'generate', 'implement']);

export const stageProgressCallbackSchema = z.custom<(line: string) => void>();

export const buildTaskBriefParamsSchema = z.object({
  ticketKey: z.string(),
  repoName: z.string(),
  repoFiles: z.array(z.string()),
  contextFiles: z.array(z.string()).optional(),
  trackedFilePaths: z.array(z.string()),
  verificationScripts: z.array(verificationScriptSchema),
  planSteps: z.array(z.string()),
  planSummary: z.string().optional(),
  planRisks: z.array(z.string()).optional(),
  planAction: resolutionActionSchema.optional(),
  skillNames: z.array(z.string()).optional(),
  figmaContextSection: z.string().optional(),
  phases: z.array(planPhaseSchema).optional(),
});

export const buildPlanContextParamsSchema = buildTaskBriefParamsSchema.extend({
  repoDir: z.string(),
});
