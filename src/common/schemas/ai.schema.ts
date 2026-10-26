import { z } from 'zod';
import { planVerificationConfigSchema } from './verification.schema';
import { codeIssueSchema, codeReviewSchema, nullableOptional } from './review.schema';

export const aiStageName = z.enum(['plan', 'implement', 'review', 'generate', 'commit', 'create']);

export const structuredOutputSchema = z.object({
  name: z.string().min(1),
  schema: z.record(z.string(), z.any()),
});

export const aiRequestSchema = z.object({
  prompt: z.string(),
  systemPrompt: z.string().optional(),
  maxTokens: z.number().optional(),
  temperature: z.number().optional(),
  context: z.record(z.string(), z.any()).optional(),
  model: z.string().optional(),
  provider: z.string().optional(),
  stage: aiStageName.optional(),
  structuredOutput: structuredOutputSchema.optional(),
  backend: z.enum(['agent', 'cli', 'standard']).optional(),
});

export const aiResponseSchema = z.object({
  content: z.string(),
  provider: z.string().optional(),
  model: z.string().optional(),
  finishReason: z.string().optional(),
  stopReason: z.string().optional(),
  refusal: z.string().nullable().optional(),
  contentTypes: z.array(z.string()).optional(),
  usage: z
    .object({
      inputTokens: z.number(),
      outputTokens: z.number(),
    })
    .optional(),
  costUsd: z.number().optional(),
});

export const aiConversationRequestSchema = z.object({
  messages: z.array(
    z.object({
      role: z.enum(['user', 'assistant']),
      content: z.string(),
    })
  ),
  systemPrompt: z.string().optional(),
  maxTokens: z.number().optional(),
  temperature: z.number().optional(),
  model: z.string().optional(),
  provider: z.string().optional(),
  stage: aiStageName.optional(),
});

export const findingsDocumentSchema = z.object({
  action: z.literal('investigate'),
  summary: z.string(),
  findings: z.array(z.string()),
  recommendations: z.array(z.string()),
  conclusion: z.string(),
});

export const fileStatusSchema = z.enum(['found', 'to-delete', 'to-create', 'not-found']);

export const fileEntrySchema = z.object({
  filePath: z.string(),
  status: fileStatusSchema,
});

export const planPhaseSchema = z.object({
  label: z.string(),
  stepIndices: z.array(z.number().int().min(0)),
  verifyAfter: nullableOptional(z.array(z.string())),
});

export const planComplexitySchema = z.enum(['low', 'medium', 'high']);

export const planRiskSchema = z.object({
  description: z.string(),
  severity: planComplexitySchema,
});

export const planStepSchema = z.object({
  description: z.string(),
  intent: nullableOptional(z.string()),
});

const planModelOutputShape = {
  action: z.enum(['fix', 'feature', 'investigate']),
  summary: z.string(),
  steps: z.array(planStepSchema),
  affectedFiles: nullableOptional(z.array(z.union([z.string(), fileEntrySchema]))),
  affectedFilesContext: nullableOptional(z.array(z.union([z.string(), fileEntrySchema]))),
  affectedRepositories: nullableOptional(z.array(z.string())),
  newRepositories: nullableOptional(z.array(z.string())),
  risks: nullableOptional(z.array(planRiskSchema)),
  verification: nullableOptional(planVerificationConfigSchema),
  provider: nullableOptional(z.string()),
  source: nullableOptional(z.string()),
  timestamp: nullableOptional(z.string()),
  phases: nullableOptional(z.array(planPhaseSchema)),
};

export const planModelOutputSchema = z.object(planModelOutputShape);

export const resolutionPlanSchema = z.object({ ...planModelOutputShape, estimatedComplexity: planComplexitySchema });

// Re-export review schemas used in AI context
export { codeIssueSchema, codeReviewSchema };
