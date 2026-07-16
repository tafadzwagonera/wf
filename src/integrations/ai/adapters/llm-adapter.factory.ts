import { ConfigService } from '@nestjs/config';
import { LLM_ADAPTER } from '../llm-adapter.interface';
import type { LlmAdapter } from '../llm-adapter.interface';
import { LoggerService } from '../../../shared/logger/logger.service';
import { AnthropicAdapter } from './anthropic.adapter';
import { GeminiAdapter } from './gemini.adapter';
import { DeepSeekAdapter } from './deepseek.adapter';
import { OpenAIAdapter } from './openai.adapter';
import type { AIConversationRequest, AIRequest, AIResponse } from '../ai.service';

interface AdapterSet {
  configService: ConfigService;
  anthropicAdapter: AnthropicAdapter;
  openaiAdapter: OpenAIAdapter;
  geminiAdapter: GeminiAdapter;
  deepseekAdapter: DeepSeekAdapter;
}

/**
 * Resolves the concrete LlmAdapter for a given provider name.
 *
 * @param provider - Optional provider key (e.g. `'openai'`, `'google'`, `'deepseek'`).
 *   Falls back to the `ai.provider` config value, then `'anthropic'`.
 * @param adapters - The set of instantiated adapters and config service.
 * @returns The matching `LlmAdapter` instance.
 */
const getAdapter = (provider: string | undefined, adapters: AdapterSet): LlmAdapter => {
  const resolved = provider ?? adapters.configService.get<string>('ai.provider', 'anthropic');
  if (resolved === 'openai') return adapters.openaiAdapter;
  if (resolved === 'google') return adapters.geminiAdapter;
  if (resolved === 'deepseek') return adapters.deepseekAdapter;
  return adapters.anthropicAdapter;
};

/**
 * Builds a routing `LlmAdapter` that delegates each call to the adapter
 * selected by the request's provider field.
 *
 * @param adapters - The set of instantiated adapters and config service.
 * @returns A composite `LlmAdapter` that dispatches to the correct backend.
 */
const buildRoutingAdapter = (adapters: AdapterSet): LlmAdapter => ({
  async execute(request: AIRequest): Promise<AIResponse> {
    return getAdapter(request.provider, adapters).execute(request);
  },
  async executeWithHistory(request: AIConversationRequest): Promise<AIResponse> {
    return getAdapter(request.provider, adapters).executeWithHistory(request);
  },
});

export const LlmAdapterFactory = {
  provide: LLM_ADAPTER,
  useFactory: (
    configService: ConfigService,
    _logger: LoggerService,
    anthropicAdapter: AnthropicAdapter,
    openaiAdapter: OpenAIAdapter,
    geminiAdapter: GeminiAdapter,
    deepseekAdapter: DeepSeekAdapter
  ): LlmAdapter => {
    return buildRoutingAdapter({ configService, anthropicAdapter, openaiAdapter, geminiAdapter, deepseekAdapter });
  },
  inject: [ConfigService, LoggerService, AnthropicAdapter, OpenAIAdapter, GeminiAdapter, DeepSeekAdapter],
};
