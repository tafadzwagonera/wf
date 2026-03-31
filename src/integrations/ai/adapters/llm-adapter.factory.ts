import { ConfigService } from '@nestjs/config';
import { LLM_ADAPTER } from '../llm-adapter.interface';
import type { LlmAdapter } from '../llm-adapter.interface';
import { LoggerService } from '../../../shared/logger/logger.service';
import { AnthropicAdapter } from './anthropic.adapter';
import { GeminiAdapter } from './gemini.adapter';
import { DeepSeekAdapter } from './deepseek.adapter';
import { OpenAIAdapter } from './openai.adapter';
import type {
  AIConversationRequest,
  AIRequest,
  AIResponse,
} from '../ai.service';

export const LlmAdapterFactory = {
  provide: LLM_ADAPTER,
  useFactory: (
    configService: ConfigService,
    logger: LoggerService,
    anthropicAdapter: AnthropicAdapter,
    openaiAdapter: OpenAIAdapter,
    geminiAdapter: GeminiAdapter,
    deepseekAdapter: DeepSeekAdapter,
  ): LlmAdapter => {
    void logger;

    const getAdapter = (provider?: string): LlmAdapter => {
      const resolvedProvider =
        provider ?? configService.get<string>('ai.provider', 'anthropic');

      if (resolvedProvider === 'openai') return openaiAdapter;
      if (resolvedProvider === 'google') return geminiAdapter;
      if (resolvedProvider === 'deepseek') return deepseekAdapter;
      return anthropicAdapter;
    };

    return {
      async execute(request: AIRequest): Promise<AIResponse> {
        return getAdapter(request.provider).execute(request);
      },
      async executeWithHistory(
        request: AIConversationRequest,
      ): Promise<AIResponse> {
        return getAdapter(request.provider).executeWithHistory(request);
      },
    };
  },
  inject: [
    ConfigService,
    LoggerService,
    AnthropicAdapter,
    OpenAIAdapter,
    GeminiAdapter,
    DeepSeekAdapter,
  ],
};
