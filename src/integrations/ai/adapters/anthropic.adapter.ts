import { Injectable, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Anthropic from '@anthropic-ai/sdk';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AIConversationRequest, AIRequest, AIResponse } from '../ai.service';
import type { LlmAdapter } from '../llm-adapter.interface';
import { AiProviderError } from '../../../common/utils/errors';
import { LoggerService } from '../../../common/logger/logger.service';
import { loadAiContextConfig } from './load-ai-context-config';
import type { UiDesignScreenshot } from '../../../common/types/ui-design-screenshot';
import { hasProviderUsageIntent, extractStageProviders } from './provider-intent';
import { classifyAiSdkError } from './ai-provider-error.classify';
import type { WfAiProviderConfig } from '../../../config/public-config';
import type { NormalizedWfConfig } from '../../../config/wf-config-loader';

const DEFAULT_MODEL = 'claude-sonnet-4-20250514';

/**
 * Returns the resolved Anthropic API key from config, or undefined if absent.
 * @param configService - NestJS config service instance
 * @returns The API key string or undefined
 */
const resolveApiKey = (configService: ConfigService): string | undefined =>
  configService.get<string>('ai.anthropicApiKey');

/**
 * Constructs the Anthropic client options object.
 * @param apiKey - The Anthropic API key
 * @returns Client init options including fetch implementation
 */
const buildAnthropicClientConfig = (apiKey: string): ConstructorParameters<typeof Anthropic>[0] => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fetchImpl = globalThis.fetch ?? require('node-fetch');
  return { apiKey, fetch: fetchImpl };
};

/**
 * Returns true for models that reject non-default sampling parameters.
 * Anthropic adaptive-thinking-only models (Opus 4.7+, Sonnet 5+, Fable, Mythos)
 * reject temperature, top_p, and top_k — passing any value causes a 400 error.
 * @param model - The model identifier string
 * @returns Whether temperature is restricted for this model
 */
const isTemperatureRestricted = (model: string): boolean =>
  /^claude-(opus-4-[7-9]|opus-[5-9]|sonnet-[5-9]|fable-|mythos-)/.test(model);

/**
 * Largest max_tokens the SDK accepts on a non-streaming request. It derives an expected
 * duration of `60min * max_tokens / 128000` and refuses anything over its 10-minute
 * non-streaming ceiling, so 128000/6 is the cutoff. Above this we must stream, otherwise
 * the SDK throws locally before the request is ever sent.
 */
const NON_STREAMING_MAX_TOKENS = 21333;

const buildStructuredOutputConfig = (structuredOutput: AIRequest['structuredOutput']) => {
  if (!structuredOutput) return {};
  return { output_config: {
    format: { type: 'json_schema', name: structuredOutput.name, schema: structuredOutput.schema, strict: true },
  } as unknown as Anthropic.MessageCreateParamsNonStreaming['output_config'] };
};

/**
 * Builds the messages.create parameter object for a single-turn request.
 * @param model - Resolved model identifier
 * @param maxTokens - Maximum tokens for the response
 * @param system - Optional system prompt string
 * @param messages - Array of conversation messages
 * @returns Parameters object for Anthropic messages.create
 */
const buildCreateParams = (
  model: string,
  maxTokens: number,
  system: string | undefined,
  messages: Anthropic.MessageParam[],
  temperature?: number,
  structuredOutput?: AIRequest['structuredOutput'],
): Anthropic.MessageCreateParamsNonStreaming => ({
  model,
  max_tokens: maxTokens,
  ...(isTemperatureRestricted(model) ? {} : { temperature: temperature ?? 0.7 }),
  system,
  messages,
  ...buildStructuredOutputConfig(structuredOutput),
});

/**
 * Maps an Anthropic API response to the shared AIResponse shape.
 * @param response - Raw Anthropic messages response
 * @param model - Model identifier used for the request
 * @returns Normalized AIResponse object
 */
const mapAnthropicResponse = (response: Anthropic.Messages.Message, model: string): AIResponse => {
  const textBlocks = response.content.filter((block): block is Anthropic.TextBlock => block.type === 'text');
  const content = textBlocks.map(block => block.text).join('');
  return {
    content,
    provider: 'anthropic',
    model,
    stopReason: response.stop_reason ?? undefined,
    contentTypes: response.content.map(block => block.type),
    usage: {
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
    },
  };
};

/**
 * Builds the message array for a conversation request.
 * @param request - The conversation request containing history and new prompt
 * @returns Array of Anthropic message params
 */
const buildMessageHistory = (request: AIConversationRequest): Anthropic.MessageParam[] => request.messages;

/**
 * Wraps an Anthropic.APIError into a retryable AiProviderError.
 * @param error - The caught Anthropic API error
 * @returns A new AiProviderError with status metadata
 */
const wrapApiError = (error: InstanceType<typeof Anthropic.APIError>): AiProviderError =>
  new AiProviderError(`Claude API error: ${error.message}`, { status: error.status }, true, classifyAiSdkError(error));

/**
 * Sends the request, streaming when max_tokens exceeds what the SDK allows
 * non-streaming. Both paths resolve to the same final message shape.
 *
 * @param client - Initialized Anthropic client
 * @param params - Create params built by buildCreateParams
 * @returns The completed Anthropic message
 */
const sendMessages = async (
  client: Anthropic,
  params: Anthropic.MessageCreateParamsNonStreaming
): Promise<Anthropic.Messages.Message> =>
  params.max_tokens > NON_STREAMING_MAX_TOKENS
    ? client.messages.stream(params).finalMessage()
    : client.messages.create(params);

/**
 * Calls the Anthropic messages API and maps the result to AIResponse.
 * @param client - Initialized Anthropic client
 * @param params - Create params built by buildCreateParams
 * @param model - Model identifier for response mapping
 * @param errorMsg - Error message used when a non-API error is thrown
 * @returns Normalized AIResponse
 */
const callMessages = async (
  client: Anthropic,
  params: Anthropic.MessageCreateParamsNonStreaming,
  model: string,
  errorMsg: string
): Promise<AIResponse> => {
  try {
    return mapAnthropicResponse(await sendMessages(client, params), model);
  } catch (error) {
    if (error instanceof Anthropic.APIError) throw wrapApiError(error);
    throw wrapNonApiError(error, params, model, errorMsg);
  }
};

/**
 * Wraps a non-APIError failure, preserving the cause and the request that produced it.
 * A `config` category means the SDK rejected the request locally, so it is not recoverable.
 *
 * @param error - The caught non-APIError value
 * @param params - Request params that produced the failure
 * @param model - Model identifier for the request
 * @param errorMsg - Error message for the wrapped error
 * @returns An AiProviderError carrying diagnosable details
 */
const wrapNonApiError = (
  error: unknown,
  params: Anthropic.MessageCreateParamsNonStreaming,
  model: string,
  errorMsg: string
): AiProviderError => {
  const category = classifyAiSdkError(error);
  return new AiProviderError(errorMsg, buildNonApiErrorDetails(error, params, model), category !== 'config', category);
};

/**
 * Builds details for a non-API failure. The raw Error is unusable once serialized, and
 * the request parameters are what makes a client-side rejection diagnosable.
 *
 * @param error - The caught non-APIError value
 * @param params - Request params that produced the failure
 * @param model - Model identifier for the request
 * @returns Serializable details describing the failure and the request that caused it
 */
const buildNonApiErrorDetails = (
  error: unknown,
  params: Anthropic.MessageCreateParamsNonStreaming,
  model: string
): Record<string, unknown> => ({
  errorName: error instanceof Error ? error.name : typeof error,
  message: error instanceof Error ? error.message : String(error),
  model,
  maxTokens: params.max_tokens,
});

const toImageBlock = (s: UiDesignScreenshot): Anthropic.ImageBlockParam => ({
  type: 'image',
  source: {
    type: 'base64',
    media_type: s.mediaType as Anthropic.Base64ImageSource['media_type'],
    data: s.base64,
  },
});

const buildAnthropicUserContent = (
  prompt: string, screenshots: UiDesignScreenshot[] | undefined,
): Anthropic.MessageParam['content'] => {
  if (!screenshots?.length) return prompt;
  return [...screenshots.map(toImageBlock), { type: 'text' as const, text: prompt }];
};

@Injectable()
export class AnthropicAdapter implements LlmAdapter, OnModuleInit {
  private client?: Anthropic;
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
      path.join(os.homedir(), '.claude', 'CLAUDE.md'),
      'CLAUDE.md',
      'anthropic',
      hasProviderUsageIntent(providers, 'anthropic', stageProviders)
    );
  }

  private warnMissingApiKey(): void {
    if (this.didWarnMissingConfig) return;
    this.logger.warn(
      'Anthropic API key not configured. Add `ai: [{ provider: "anthropic", apiKey: "..." }]` to wf.config.*.'
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
    this.client = new Anthropic(buildAnthropicClientConfig(apiKey));
    this.model = this.configService.get<string>('ai.model', DEFAULT_MODEL);
    this.logger.debug(`Initialized Anthropic adapter with model: ${this.model}`);
  }

  private prependConfig(systemPrompt: string | undefined): string | undefined {
    if (!this.contextConfig) return systemPrompt;
    return this.contextConfig + (systemPrompt ?? '');
  }

  private assertClient(): Anthropic {
    if (!this.client) {
      throw new AiProviderError(
        'Anthropic client not initialized. Configure `ai[].apiKey` for the `anthropic` provider in wf.config.*.',
        null,
        false
      );
    }
    return this.client;
  }

  async execute(request: AIRequest): Promise<AIResponse> {
    this.initializeClient();
    const client = this.assertClient();
    this.logger.debug('Executing AI request via Anthropic');
    const model = request.model || this.model;
    const maxTokens = request.maxTokens || this.maxTokens;
    const system = this.prependConfig(request.systemPrompt);
    const userContent = buildAnthropicUserContent(
      request.prompt, request.context?.screenshots as UiDesignScreenshot[] | undefined,
    );
    const msgs: Anthropic.MessageParam[] = [{ role: 'user', content: userContent }];
    return callMessages(client, buildCreateParams(model, maxTokens, system, msgs, request.temperature, request.structuredOutput), model, 'Failed to execute AI request');
  }

  async executeWithHistory(request: AIConversationRequest): Promise<AIResponse> {
    this.initializeClient();
    const client = this.assertClient();
    this.logger.debug(`Executing conversation request with ${request.messages.length} messages via Anthropic`);
    const model = request.model || this.model;
    const maxTokens = request.maxTokens || this.maxTokens;
    const system = this.prependConfig(request.systemPrompt);
    const messages = buildMessageHistory(request);
    return callMessages(client, buildCreateParams(model, maxTokens, system, messages, request.temperature), model, 'Failed to execute conversation request');
  }
}
