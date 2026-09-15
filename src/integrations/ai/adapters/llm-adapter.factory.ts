import { ConfigService } from '@nestjs/config';
import { LLM_ADAPTER } from '../llm-adapter.interface';
import type { LlmAdapter } from '../llm-adapter.interface';
import { LoggerService } from '../../../shared/logger/logger.service';
import { appendToLogFile } from '../../../shared/logger/log-file-writer';
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
/**
 * Records a completed raw-API call to the log file. Every call routed here is
 * billed to a configured API key (never subscription auth), so the line carries
 * `billing=api-key` alongside provider, model, and token usage for cost forensics.
 *
 * @param stage - The workflow stage that issued the request, if any
 * @param response - The adapter response carrying provider, model, and usage
 */
const logLlmCall = (stage: string | undefined, response: AIResponse): void => {
  const fields = [
    `stage=${stage ?? 'none'}`,
    `provider=${response.provider ?? 'unknown'}`,
    `model=${response.model ?? 'unknown'}`,
    `inputTokens=${response.usage?.inputTokens ?? 'unknown'}`,
    `outputTokens=${response.usage?.outputTokens ?? 'unknown'}`,
    'billing=api-key',
  ].join(' ');
  appendToLogFile('INFO', `llm.call ${fields}`, 'llm-adapter');
};

const buildRoutingAdapter = (adapters: AdapterSet): LlmAdapter => ({
  async execute(request: AIRequest): Promise<AIResponse> {
    const response = await getAdapter(request.provider, adapters).execute(request);
    logLlmCall(request.stage, response);
    return response;
  },
  async executeWithHistory(request: AIConversationRequest): Promise<AIResponse> {
    const response = await getAdapter(request.provider, adapters).executeWithHistory(request);
    logLlmCall(request.stage, response);
    return response;
  },
});

export const LlmAdapterFactory = {
  provide: LLM_ADAPTER,
  useFactory: (
    configService: ConfigService,
    logger: LoggerService,
    anthropicAdapter: AnthropicAdapter,
    openaiAdapter: OpenAIAdapter,
    geminiAdapter: GeminiAdapter,
    deepseekAdapter: DeepSeekAdapter
  ): LlmAdapter => {
    const defaultProvider = configService.get<string>('ai.provider', 'anthropic');
    const defaultModel = configService.get<string>('ai.model', '');
    const modelSuffix = defaultModel ? ` default-model=${defaultModel}` : '';
    logger.info(`llm.adapter default-provider=${defaultProvider}${modelSuffix}`);
    return buildRoutingAdapter({ configService, anthropicAdapter, openaiAdapter, geminiAdapter, deepseekAdapter });
  },
  inject: [ConfigService, LoggerService, AnthropicAdapter, OpenAIAdapter, GeminiAdapter, DeepSeekAdapter],
};
