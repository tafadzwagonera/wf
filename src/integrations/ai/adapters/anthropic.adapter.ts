import { Injectable, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Anthropic from '@anthropic-ai/sdk';
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
  messages: Anthropic.MessageParam[]
): Anthropic.MessageCreateParamsNonStreaming => ({
  model,
  max_tokens: maxTokens,
  ...(isTemperatureRestricted(model) ? {} : { temperature: 0.7 }),
  system,
  messages,
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
 * Wraps an Anthropic.APIError into a retryable AIError.
 * @param error - The caught Anthropic API error
 * @returns A new AIError with status metadata
 */
const wrapApiError = (error: Anthropic.APIError): AIError =>
  new AIError(`Claude API error: ${error.message}`, { status: error.status }, true);

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
    const response = await client.messages.create(params);
    return mapAnthropicResponse(response, model);
  } catch (error) {
    if (error instanceof Anthropic.APIError) throw wrapApiError(error);
    throw new AIError(errorMsg, error);
  }
};

@Injectable()
export class AnthropicAdapter implements LlmAdapter, OnModuleInit {
  private client?: Anthropic;
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
      throw new AIError(
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
    const messages: Anthropic.MessageParam[] = [{ role: 'user', content: request.prompt }];
    return callMessages(client, buildCreateParams(model, maxTokens, system, messages), model, 'Failed to execute AI request');
  }

  async executeWithHistory(request: AIConversationRequest): Promise<AIResponse> {
    this.initializeClient();
    const client = this.assertClient();
    this.logger.debug(`Executing conversation request with ${request.messages.length} messages via Anthropic`);
    const model = request.model || this.model;
    const maxTokens = request.maxTokens || this.maxTokens;
    const system = this.prependConfig(request.systemPrompt);
    const messages = buildMessageHistory(request);
    return callMessages(client, buildCreateParams(model, maxTokens, system, messages), model, 'Failed to execute conversation request');
  }
}
