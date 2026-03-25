import type {
  AIConversationRequest,
  AIRequest,
  AIResponse,
} from './ai.service';

export const LLM_ADAPTER = 'LLM_ADAPTER';

export interface LlmAdapter {
  execute(request: AIRequest): Promise<AIResponse>;
  executeWithHistory(request: AIConversationRequest): Promise<AIResponse>;
}
