import type { z } from 'zod';
import type {
  chatSessionOptionsSchema,
  conversationContextSchema,
  conversationMessageSchema,
  conversationStateSchema,
  workflowStageSchema,
} from '../schemas/conversation.schema';

export type ChatSessionOptions = z.infer<typeof chatSessionOptionsSchema>;
export type ConversationContext = z.infer<typeof conversationContextSchema>;
export type ConversationMessage = z.infer<typeof conversationMessageSchema>;
export type ConversationState = z.infer<typeof conversationStateSchema>;
export type WorkflowStage = z.infer<typeof workflowStageSchema>;
