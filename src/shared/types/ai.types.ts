import type { z } from 'zod';
import type {
  aiRequestSchema,
  aiResponseSchema,
  aiConversationRequestSchema,
  findingsDocumentSchema,
  fileStatusSchema,
  fileEntrySchema,
  resolutionPlanSchema,
} from '../schemas/ai.schema';

export type AIRequest = z.infer<typeof aiRequestSchema>;
export type AIResponse = z.infer<typeof aiResponseSchema>;
export type AIConversationRequest = z.infer<typeof aiConversationRequestSchema>;
export type FindingsDocument = z.infer<typeof findingsDocumentSchema>;
export type FileStatus = z.infer<typeof fileStatusSchema>;
export type FileEntry = z.infer<typeof fileEntrySchema>;
export type ResolutionPlan = z.infer<typeof resolutionPlanSchema>;
