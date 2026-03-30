/**
 * Workflow stages where interactive chat can be activated
 */
export type WorkflowStage =
  | 'fetch'
  | 'plan'
  | 'implement'
  | 'review'
  | 'commit';

/**
 * Represents a single message in a conversation
 */
export interface ConversationMessage {
  role: 'user' | 'assistant';
  content: string;
  timestamp: Date;
  tokenUsage?: {
    inputTokens: number;
    outputTokens: number;
  };
}

/**
 * Context information for a conversation tied to a workflow stage
 */
export interface ConversationContext {
  ticketKey: string;
  stage: WorkflowStage;
  stageOutput?: any;
  repoDir?: string;
  platformName?: string;
  workflowState: {
    ticketContent: string;
    plan?: any;
    review?: any;
  };
}

/**
 * Complete state of a conversation including history and metadata
 */
export interface ConversationState {
  conversationId: string;
  ticketKey: string;
  messages: ConversationMessage[];
  context: ConversationContext;
  totalTokensUsed: {
    input: number;
    output: number;
  };
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Options for configuring a chat session
 */
export interface ChatSessionOptions {
  systemPrompt?: string;
  maxTurns?: number;
  exitCommands?: string[];
}
