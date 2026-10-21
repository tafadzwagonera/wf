import { Injectable, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GoogleGenerativeAI } from '@google/generative-ai';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AIConversationRequest, AIRequest, AIResponse } from '../ai.service';
import type { LlmAdapter } from '../llm-adapter.interface';
import { AiProviderError } from '../../../common/utils/errors';
import { LoggerService } from '../../../common/logger/logger.service';
import { loadAiContextConfig } from './load-ai-context-config';
import { hasProviderUsageIntent, extractStageProviders } from './provider-intent';
import { classifyAiSdkError } from './ai-provider-error.classify';
import type { WfAiProviderConfig } from '../../../config/public-config';
import type { NormalizedWfConfig } from '../../../config/wf-config-loader';

const DEFAULT_MODEL = 'gemini-2.5-pro';

// Arbitrarily chosen safe power of two (2^12). For gemini-2.5-* thinking
// models, maxOutputTokens is a shared budget covering both thinking tokens and
// response tokens — a low per-call override (e.g. 500) can be exhausted by
// thinking alone, leaving no tokens for the actual response. This floor
// ensures there is always room for output after thinking completes.
// Ref: https://ai.google.dev/gemini-api/docs/thinking
const MAX_TOKENS = 4096;

type GeminiResponseShape = {
  candidates?: Array<{
    finishReason?: string;
    content?: { parts?: Array<{ text?: string }> };
  }>;
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
  };
};

type GeminiHistoryEntry = { role: string; parts: Array<{ text: string }> };

/**
 * Resolves the Gemini API key from config, emitting a one-time warning when absent.
 * @param configService - NestJS ConfigService instance.
 * @param logger - Logger used to emit the missing-key warning.
 * @param didWarn - Whether the warning has already been emitted.
 * @returns Tuple of [apiKey, updatedDidWarn].
 */
const resolveGeminiApiKey = (
  configService: ConfigService,
  logger: LoggerService,
  didWarn: boolean
): [string | undefined, boolean] => {
  const apiKey = configService.get<string>('ai.geminiApiKey');
  if (apiKey) return [apiKey, didWarn];
  if (!didWarn) {
    logger.warn('Gemini API key not configured. Add `ai: [{ provider: "google", apiKey: "..." }]` to wf.config.*.');
  }
  return [undefined, true];
};

/**
 * Extracts token usage counts from a Gemini response.
 * @param response - Raw Gemini response object.
 * @returns Object with inputTokens and outputTokens.
 */
const extractUsageMetadata = (response: GeminiResponseShape): { inputTokens: number; outputTokens: number } => ({
  inputTokens: response.usageMetadata?.promptTokenCount ?? 0,
  outputTokens: response.usageMetadata?.candidatesTokenCount ?? 0,
});

/**
 * Extracts content-type labels from a Gemini response's candidate parts.
 * @param response - Raw Gemini response object.
 * @returns Array of content-type strings, or undefined when no candidates exist.
 */
const extractContentParts = (response: GeminiResponseShape): string[] | undefined =>
  response.candidates?.flatMap(candidate => {
    const parts = candidate.content?.parts ?? [];
    return parts.length === 0 ? ['text'] : parts.map(part => ('text' in part ? 'text' : 'unknown'));
  });

/**
 * Computes the effective maxOutputTokens for a Gemini request.
 * @param model - The Gemini model name.
 * @param requestTokens - Per-request token override, if any.
 * @param adapterTokens - Adapter-level default max tokens.
 * @returns Effective maxOutputTokens value.
 */
const resolveMaxOutputTokens = (model: string, requestTokens: number | undefined, adapterTokens: number): number => {
  const base = requestTokens ?? adapterTokens;
  return model.startsWith('gemini-2.5') ? Math.max(base, MAX_TOKENS) : base;
};

/**
 * Builds the generative model config for a Gemini request.
 * @param client - GoogleGenerativeAI client instance.
 * @param model - The Gemini model name.
 * @param systemInstruction - Optional system prompt string.
 * @param maxOutputTokens - Effective output token limit.
 * @param temperature - Sampling temperature.
 * @returns A configured generative model instance.
 */
const buildGeminiModel = (
  client: GoogleGenerativeAI,
  model: string,
  systemInstruction: string | undefined,
  maxOutputTokens: number,
  temperature: number
) =>
  client.getGenerativeModel({
    model,
    systemInstruction,
    generationConfig: { maxOutputTokens, temperature },
  });

/**
 * Converts AIConversationRequest messages (excluding the last) to Gemini history format.
 * @param messages - Full message list from the conversation request.
 * @returns Array of Gemini history entries.
 */
const buildGeminiHistory = (messages: AIConversationRequest['messages']): GeminiHistoryEntry[] =>
  messages.slice(0, -1).map(msg => ({
    role: msg.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: msg.content }],
  }));

@Injectable()
export class GeminiAdapter implements LlmAdapter, OnModuleInit {
  private client?: GoogleGenerativeAI;
  private model = DEFAULT_MODEL;
  private maxTokens = 4096;
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
      path.join(os.homedir(), '.gemini', 'GEMINI.md'),
      'GEMINI.md',
      'gemini',
      hasProviderUsageIntent(providers, 'google', stageProviders)
    );
  }

  private initializeClient(): void {
    if (this.client) return;

    const [apiKey, didWarn] = resolveGeminiApiKey(this.configService, this.logger, this.didWarnMissingConfig);
    this.didWarnMissingConfig = didWarn;

    if (!apiKey) return;

    this.client = new GoogleGenerativeAI(apiKey);
    this.model = this.configService.get<string>('ai.model') || DEFAULT_MODEL;
    this.maxTokens = this.configService.get<number>('ai.maxTokens', 4096);
    this.logger.debug(`Initialized Gemini adapter with model: ${this.model}`);
  }

  private prependConfig(systemPrompt: string | undefined): string | undefined {
    if (!this.contextConfig) return systemPrompt;
    return this.contextConfig + (systemPrompt ?? '');
  }

  private buildResponseMetadata(content: string, model: string, response: GeminiResponseShape): AIResponse {
    return {
      content,
      provider: 'google',
      model,
      finishReason: response.candidates?.[0]?.finishReason,
      contentTypes: extractContentParts(response),
      usage: extractUsageMetadata(response),
    };
  }

  private assertClient(): GoogleGenerativeAI {
    if (this.client) return this.client;
    throw new AiProviderError(
      'Gemini client not initialized. Configure `ai[].apiKey` for the `google` provider in wf.config.*.',
      null,
      false
    );
  }

  private buildModel(client: GoogleGenerativeAI, request: AIRequest | AIConversationRequest) {
    const model = request.model || this.model;
    const maxOutputTokens = resolveMaxOutputTokens(model, request.maxTokens, this.maxTokens);
    return { model, generativeModel: buildGeminiModel(
      client, model, this.prependConfig(request.systemPrompt), maxOutputTokens, request.temperature ?? 0.7
    ) };
  }

  async execute(request: AIRequest): Promise<AIResponse> {
    this.initializeClient();
    const client = this.assertClient();
    this.logger.debug('Executing AI request via Gemini');
    try {
      const { model, generativeModel } = this.buildModel(client, request);
      const result = await generativeModel.generateContent(request.prompt);
      return this.buildResponseMetadata(result.response.text(), model, result.response);
    } catch (error) {
      throw new AiProviderError(`Gemini API error: ${error instanceof Error ? error.message : String(error)}`, error, true, classifyAiSdkError(error));
    }
  }

  async executeWithHistory(request: AIConversationRequest): Promise<AIResponse> {
    this.initializeClient();
    const client = this.assertClient();
    this.logger.debug(`Executing conversation request with ${request.messages.length} messages via Gemini`);
    try {
      const { model, generativeModel } = this.buildModel(client, request);
      const history = buildGeminiHistory(request.messages);
      const lastMessage = request.messages.at(-1);
      if (!lastMessage) throw new AiProviderError('Cannot execute conversation with empty message history', undefined, false);
      const result = await generativeModel.startChat({ history }).sendMessage(lastMessage.content);
      return this.buildResponseMetadata(result.response.text(), model, result.response);
    } catch (error) {
      throw new AiProviderError(`Gemini API error: ${error instanceof Error ? error.message : String(error)}`, error, true, classifyAiSdkError(error));
    }
  }
}
