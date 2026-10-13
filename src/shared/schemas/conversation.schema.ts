import { z } from 'zod';

export const workflowStageSchema = z.enum(['fetch', 'plan', 'implement', 'review', 'commit']);

export const conversationMessageSchema = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.string(),
  timestamp: z.date(),
  tokenUsage: z
    .object({
      inputTokens: z.number(),
      outputTokens: z.number(),
    })
    .optional(),
});

export const conversationContextSchema = z.object({
  ticketKey: z.string(),
  stage: workflowStageSchema,
  stageOutput: z.any().optional(),
  repoDir: z.string().optional(),
  trackerName: z.string().optional(),
  artifactDir: z.string().optional(),
  workflowState: z.object({
    ticketContent: z.string(),
    plan: z.any().optional(),
    review: z.any().optional(),
  }),
});

export const conversationStateSchema = z.object({
  conversationId: z.string(),
  ticketKey: z.string(),
  messages: z.array(conversationMessageSchema),
  context: conversationContextSchema,
  totalTokensUsed: z.object({
    input: z.number(),
    output: z.number(),
  }),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export const chatSessionOptionsSchema = z.object({
  systemPrompt: z.string().optional(),
  maxTurns: z.number().optional(),
  exitCommands: z.array(z.string()).optional(),
  stage: workflowStageSchema.optional(),
  repoDir: z.string().optional(),
  resumeProviderSessionId: z.string().optional(),
});
