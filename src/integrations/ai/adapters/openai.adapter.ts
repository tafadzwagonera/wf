import { Injectable, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';
import * as os from 'os';
import * as path from 'path';
import type { AIConversationRequest, AIRequest, AIResponse } from '../ai.service';
import type { LlmAdapter } from '../llm-adapter.interface';
import { AIError } from '../../../shared/utils/errors';
import { LoggerService } from '../../../shared/logger/logger.service';
import { loadAiContextConfig } from './load-ai-context-config';
import { hasProviderUsageIntent, extractStageProviders } from './provider-intent';
import type { WfAiProviderConfig } from '../../../config/public-config';
import type { NormalizedWfConfig } from '../../../config/wf-config-loader';

const DEFAULT_MODEL = 'gpt-4.1';

type ChatMessage = { role: 'system' | 'user' | 'assistant'; content: string };

/**
 * Resolves the OpenAI API key from config, emitting a one-time warning when absent.
 * @param configService - NestJS config service instance.
 * @param didWarn - Whether the missing-config warning has already been emitted.
 * @param warn - Callback to emit the warning message.
 * @returns The API key string, or undefined if not configured.
 */
const resolveApiKey = (
  configService: ConfigService,
  didWarn: boolean,
  warn: (msg: string) => void
): string | undefined => {
  const apiKey = configService.get<string>('ai.openaiApiKey');
  if (!apiKey && !didWarn) {
    warn('OpenAI API key not configured. Add `ai: [{ provider: "openai", apiKey: "..." }]` to wf.config.*.');
  }
  return apiKey;
};

/**
 * Builds the OpenAI client constructor config.
 * @param apiKey - The resolved OpenAI API key.
 * @returns An object suitable for passing to `new OpenAI(...)`.
 */
const buildOpenAiClientConfig = (apiKey: string): { apiKey: string } => ({ apiKey });

/**
 * Builds the chat completion request parameters for the OpenAI API.
 * @param model - The model identifier to use.
 * @param maxTokens - The maximum number of completion tokens.
 * @param temperature - The sampling temperature (omitted for restricted models).
 * @param messages - The formatted chat messages.
 * @returns A params object for `client.chat.completions.create`.
 */
const buildCompletionParams = (
  model: string,
  maxTokens: number,
  temperature: number,
  messages: OpenAI.Chat.ChatCompletionMessageParam[]
): OpenAI.Chat.ChatCompletionCreateParamsNonStreaming => {
  const isRestricted = /^(o\d|gpt-5)/.test(model);
  const tempParam = isRestricted ? {} : { temperature };
  return { model, max_completion_tokens: maxTokens, ...tempParam, messages };
};

/**
 * Maps an OpenAI chat completion response to the shared AIResponse shape.
 * @param response - The raw OpenAI completion response.
 * @param model - The model identifier used for the request.
 * @returns A normalized AIResponse object.
 */
const mapOpenAiResponse = (response: OpenAI.Chat.ChatCompletion, model: string): AIResponse => {
  const choice = response.choices[0];
  return {
    content: choice.message.content ?? '',
    provider: 'openai',
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
 * Builds the message history array, prepending an optional system prompt.
 * @param systemPrompt - Optional system prompt to prepend.
 * @param conversationMessages - The ordered conversation messages.
 * @returns A flat array of ChatMessage objects.
 */
const buildMessageHistory = (
  systemPrompt: string | undefined,
  conversationMessages: ChatMessage[]
): ChatMessage[] => {
  const system: ChatMessage[] = systemPrompt ? [{ role: 'system', content: systemPrompt }] : [];
  return [...system, ...conversationMessages];
};

/**
 * Extracts the HTTP status from an unknown error object, if present.
 * @param error - The caught error value.
 * @returns An object with an optional `status` number field.
 */
const getApiErrorDetails = (error: unknown): { status?: number } =>
  typeof error === 'object' && error !== null && 'status' in error && typeof error.status === 'number'
    ? { status: error.status }
    : {};

@Injectable()
export class OpenAIAdapter implements LlmAdapter, OnModuleInit {
  private client?: OpenAI;
  private model = DEFAULT_MODEL;
  private maxTokens = 4096;
  private contextConfig = '';
  private didWarnMissingConfig = false;

  constructor(
    private configService: ConfigService,
    private logger: LoggerService
  ) {}

  async onModuleInit(): Promise<void> {
    const providers = this.configService.get<WfAiProviderConfig[]>('ai.providers') ?? [];
    const stages = this.configService.get<NormalizedWfConfig['stages']>('stages');
    const stageProviders = extractStageProviders(stages);

    this.contextConfig = await loadAiContextConfig(
      path.join(os.homedir(), '.openai', 'OPENAI.md'),
      '.openai/OPENAI.md',
      'openai',
      hasProviderUsageIntent(providers, 'openai', stageProviders)
    );
  }

  private initializeClient(): void {
    if (this.client) return;

    const apiKey = resolveApiKey(this.configService, this.didWarnMissingConfig, msg => this.logger.warn(msg));
    if (!apiKey) {
      this.didWarnMissingConfig = true;
      return;
    }

    this.client = new OpenAI(buildOpenAiClientConfig(apiKey));
    this.model = this.configService.get<string>('ai.model') || DEFAULT_MODEL;
    this.logger.debug(`Initialized OpenAI adapter with model: ${this.model}`);
  }

  private prependConfig(systemPrompt: string | undefined): string | undefined {
    return this.contextConfig ? this.contextConfig + (systemPrompt ?? '') : systemPrompt;
  }

  private assertClient(): void {
    if (!this.client) {
      throw new AIError(
        'OpenAI client not initialized. Configure `ai[].apiKey` for the `openai` provider in wf.config.*.',
        null,
        false
      );
    }
  }

  /**
   * Invokes the OpenAI chat completions API and maps the result to AIResponse.
   * Wraps OpenAI.APIError and generic errors with AIError.
   * @param params - The chat completion request parameters.
   * @param model - The model identifier used for the request.
   * @param errorMsg - The message to use when wrapping a generic error.
   * @returns A normalized AIResponse from the completion.
   */
  private async invokeCompletion(
    params: OpenAI.Chat.ChatCompletionCreateParamsNonStreaming,
    model: string,
    errorMsg: string
  ): Promise<AIResponse> {
    try {
      const response = await this.client!.chat.completions.create(params);
      return mapOpenAiResponse(response, model);
    } catch (error) {
      if (error instanceof OpenAI.APIError) {
        throw new AIError(`OpenAI API error: ${error.message}`, getApiErrorDetails(error), true);
      }
      throw new AIError(errorMsg, error);
    }
  }

  async execute(request: AIRequest): Promise<AIResponse> {
    this.initializeClient();
    this.assertClient();
    this.logger.debug('Executing AI request via OpenAI');
    const systemPrompt = this.prependConfig(request.systemPrompt);
    const messages = buildMessageHistory(systemPrompt, [{ role: 'user', content: request.prompt }]);
    const model = request.model || this.model;
    const params = buildCompletionParams(
      model, request.maxTokens || this.maxTokens, request.temperature || 0.7, messages
    );
    return this.invokeCompletion(params, model, 'Failed to execute AI request');
  }

  async executeWithHistory(request: AIConversationRequest): Promise<AIResponse> {
    this.initializeClient();
    this.assertClient();
    this.logger.debug(`Executing conversation request with ${request.messages.length} messages via OpenAI`);
    const systemPrompt = this.prependConfig(request.systemPrompt);
    const messages = buildMessageHistory(systemPrompt, request.messages);
    const model = request.model || this.model;
    const params = buildCompletionParams(
      model, request.maxTokens || this.maxTokens, request.temperature || 0.7, messages
    );
    return this.invokeCompletion(params, model, 'Failed to execute conversation request');
  }
}
