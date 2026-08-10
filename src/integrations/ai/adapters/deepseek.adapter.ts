import { Injectable, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AIConversationRequest, AIRequest, AIResponse } from '../ai.service';
import type { LlmAdapter } from '../llm-adapter.interface';
import { AiProviderError } from '../../../shared/utils/errors';
import { LoggerService } from '../../../shared/logger/logger.service';
import { loadAiContextConfig } from './load-ai-context-config';
import { hasProviderUsageIntent, extractStageProviders } from './provider-intent';
import { classifyAiSdkError } from './ai-provider-error.classify';
import type { WfAiProviderConfig } from '../../../config/public-config';
import type { NormalizedWfConfig } from '../../../config/wf-config-loader';

const DEFAULT_MODEL = 'deepseek-reasoner';
const DEEPSEEK_BASE_URL = 'https://api.deepseek.com/v1';

/**
 * @param configService - NestJS config service
 * @returns The resolved DeepSeek API key or undefined
 */
const resolveApiKey = (configService: ConfigService): string | undefined =>
  configService.get<string>('ai.deepseekApiKey');

/**
 * @param apiKey - DeepSeek API key
 * @returns OpenAI client constructor options with DeepSeek base URL
 */
const buildDeepSeekClientConfig = (apiKey: string): { apiKey: string; baseURL: string } => ({
  apiKey,
  baseURL: DEEPSEEK_BASE_URL,
});

/**
 * @param response - Raw OpenAI chat completion response
 * @param model - Model identifier used for the request
 * @returns Normalized AIResponse
 */
const mapDeepSeekResponse = (response: OpenAI.Chat.ChatCompletion, model: string): AIResponse => {
  const choice = response.choices[0];
  return {
    content: choice.message.content ?? '',
    provider: 'deepseek',
    model,
    finishReason: choice.finish_reason ?? undefined,
    refusal: choice.message.refusal ?? null,
    usage: {
      inputTokens: response.usage?.prompt_tokens ?? 0,
      outputTokens: response.usage?.completion_tokens ?? 0,
    },
  };
};

/**
 * @param request - AI request with prompt, model, and token settings
 * @param messages - Pre-built message list (system + user messages)
 * @param defaultModel - Fallback model if request does not specify one
 * @param defaultMaxTokens - Fallback max tokens if request does not specify one
 * @returns OpenAI chat completion create params
 */
const buildCompletionParams = (
  request: AIRequest | AIConversationRequest,
  messages: OpenAI.Chat.ChatCompletionMessageParam[],
  defaultModel: string,
  defaultMaxTokens: number
): OpenAI.Chat.ChatCompletionCreateParamsNonStreaming => ({
  model: request.model || defaultModel,
  max_tokens: request.maxTokens || defaultMaxTokens,
  temperature: request.temperature || 0.7,
  messages,
});

/**
 * @param request - Conversation request containing message history
 * @param systemPrompt - Optional system prompt to prepend as first message
 * @returns Ordered list of chat messages including system and history
 */
const buildMessageHistory = (
  request: AIConversationRequest,
  systemPrompt: string | undefined
): OpenAI.Chat.ChatCompletionMessageParam[] => {
  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [];
  if (systemPrompt) {
    messages.push({ role: 'system', content: systemPrompt });
  }
  for (const msg of request.messages) {
    messages.push({ role: msg.role, content: msg.content });
  }
  return messages;
};

/**
 * @param error - Caught error from OpenAI client
 * @param fallbackMessage - Human-readable fallback message for non-API errors
 * @throws AiProviderError always
 */
const throwDeepSeekError = (error: unknown, fallbackMessage: string): never => {
  if (error instanceof OpenAI.APIError) {
    throw new AiProviderError(`DeepSeek API error: ${error.message}`, { status: error.status }, true, classifyAiSdkError(error));
  }
  throw new AiProviderError(fallbackMessage, error, true, classifyAiSdkError(error));
};

/**
 * @param request - Single-turn AI request with prompt and optional system prompt
 * @param systemPrompt - Optional (already prepended) system prompt
 * @returns Ordered message list for the completion call
 */
const buildSingleTurnMessages = (
  request: AIRequest,
  systemPrompt: string | undefined
): OpenAI.Chat.ChatCompletionMessageParam[] => {
  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [];
  if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });
  messages.push({ role: 'user', content: request.prompt });
  return messages;
};

@Injectable()
export class DeepSeekAdapter implements LlmAdapter, OnModuleInit {
  private client?: OpenAI;
  private model = DEFAULT_MODEL;
  private readonly maxTokens = 4096;
  private contextConfig = '';
  private didWarnMissingConfig = false;

  constructor(
    private readonly configService: ConfigService,
    private readonly logger: LoggerService
  ) {}

  async onModuleInit(): Promise<void> {
    const providers = this.configService.get<WfAiProviderConfig[]>('ai.providers') ?? [];
    const stages = this.configService.get<NormalizedWfConfig['stages']>('stages');
    const stageProviders = extractStageProviders(stages);

    this.contextConfig = await loadAiContextConfig(
      path.join(os.homedir(), '.deepseek', 'DEEPSEEK.md'),
      'DEEPSEEK.md',
      'deepseek',
      hasProviderUsageIntent(providers, 'deepseek', stageProviders)
    );
  }

  private warnMissingApiKey(): void {
    if (this.didWarnMissingConfig) return;
    this.logger.warn(
      'DeepSeek API key not configured. Add `ai: [{ provider: "deepseek", apiKey: "..." }]` to wf.config.*.'
    );
    this.didWarnMissingConfig = true;
  }

  private initializeClient(): void {
    if (this.client) return;
    const apiKey = resolveApiKey(this.configService);
    if (!apiKey) {
      this.warnMissingApiKey();
      return;
    }
    this.client = new OpenAI(buildDeepSeekClientConfig(apiKey));
    this.model = this.configService.get<string>('ai.model') || DEFAULT_MODEL;
    this.logger.debug(`Initialized DeepSeek adapter with model: ${this.model}`);
  }

  private prependConfig(systemPrompt: string | undefined): string | undefined {
    if (!this.contextConfig) return systemPrompt;
    return this.contextConfig + (systemPrompt ?? '');
  }

  private assertClient(): OpenAI {
    if (!this.client) {
      throw new AiProviderError(
        'DeepSeek client not initialized. Configure `ai[].apiKey` for the `deepseek` provider in wf.config.*.',
        null,
        false
      );
    }
    return this.client;
  }

  async execute(request: AIRequest): Promise<AIResponse> {
    this.initializeClient();
    const client = this.assertClient();
    this.logger.debug('Executing AI request via DeepSeek');

    const systemPrompt = this.prependConfig(request.systemPrompt);
    const messages = buildSingleTurnMessages(request, systemPrompt);
    const params = buildCompletionParams(request, messages, this.model, this.maxTokens);

    try {
      const response = await client.chat.completions.create(params);
      return mapDeepSeekResponse(response, params.model);
    } catch (error) {
      return throwDeepSeekError(error, 'Failed to execute AI request');
    }
  }

  async executeWithHistory(request: AIConversationRequest): Promise<AIResponse> {
    this.initializeClient();
    const client = this.assertClient();
    this.logger.debug(`Executing conversation request with ${request.messages.length} messages via DeepSeek`);

    const systemPrompt = this.prependConfig(request.systemPrompt);
    const messages = buildMessageHistory(request, systemPrompt);
    const params = buildCompletionParams(request, messages, this.model, this.maxTokens);

    try {
      const response = await client.chat.completions.create(params);
      return mapDeepSeekResponse(response, params.model);
    } catch (error) {
      return throwDeepSeekError(error, 'Failed to execute conversation request');
    }
  }
}
