import { z } from 'zod';
import { planVerificationConfigSchema } from './verification.schema';
import { codeIssueSchema, codeReviewSchema } from './review.schema';

export const aiStageName = z.enum(['plan', 'implement', 'review', 'generate', 'commit', 'create']);

export const aiRequestSchema = z.object({
  prompt: z.string(),
  systemPrompt: z.string().optional(),
  maxTokens: z.number().optional(),
  temperature: z.number().optional(),
  context: z.record(z.string(), z.any()).optional(),
  model: z.string().optional(),
  provider: z.string().optional(),
  stage: aiStageName.optional(),
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

export const fileStatusSchema = z.enum(['found', 'to-create', 'not-found']);

export const fileEntrySchema = z.object({
  filePath: z.string(),
  status: fileStatusSchema,
});

export const resolutionPlanSchema = z.object({
  action: z.enum(['fix', 'feature', 'investigate']),
  summary: z.string(),
  steps: z.array(z.string()),
  estimatedComplexity: z.enum(['low', 'medium', 'high']),
  affectedFiles: z.array(z.union([z.string(), fileEntrySchema])).optional(),
  affectedFilesContext: z.array(z.union([z.string(), fileEntrySchema])).optional(),
  repositoriesAffected: z.array(z.string()).optional(),
  risks: z.array(z.string()).optional(),
  verification: planVerificationConfigSchema.optional(),
  provider: z.string().optional(),
  source: z.string().optional(),
  timestamp: z.string().optional(),
});

// Re-export review schemas used in AI context
export { codeIssueSchema, codeReviewSchema };
