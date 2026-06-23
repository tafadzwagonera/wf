import { Injectable, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GoogleGenerativeAI } from '@google/generative-ai';
import * as os from 'os';
import * as path from 'path';
import type {
  AIConversationRequest,
  AIRequest,
  AIResponse,
} from '../ai.service';
import type { LlmAdapter } from '../llm-adapter.interface';
import { AIError } from '../../../shared/utils/errors';
import { LoggerService } from '../../../shared/logger/logger.service';
import { loadAiContextConfig } from './load-ai-context-config';
import { hasProviderUsageIntent } from './provider-intent';
import type { WfAiProviderConfig } from '../../../config/public-config';

const DEFAULT_MODEL = 'gemini-2.5-pro';

// Arbitrarily chosen safe power of two (2^12). For gemini-2.5-* thinking
// models, maxOutputTokens is a shared budget covering both thinking tokens and
// response tokens — a low per-call override (e.g. 500) can be exhausted by
// thinking alone, leaving no tokens for the actual response. This floor
// ensures there is always room for output after thinking completes.
// Ref: https://ai.google.dev/gemini-api/docs/thinking
const MAX_TOKENS = 4096;

@Injectable()
export class GeminiAdapter implements LlmAdapter, OnModuleInit {
  private client?: GoogleGenerativeAI;
  private model = DEFAULT_MODEL;
  private maxTokens = 4096;
  private contextConfig = '';
  private didWarnMissingConfig = false;

  constructor(
    private configService: ConfigService,
    private logger: LoggerService,
  ) {}

  async onModuleInit(): Promise<void> {
    const providers =
      this.configService.get<WfAiProviderConfig[]>('ai.providers') ?? [];

    this.contextConfig = await loadAiContextConfig(
      path.join(os.homedir(), '.gemini', 'GEMINI.md'),
      'GEMINI.md',
      'gemini',
      hasProviderUsageIntent(providers, 'google'),
    );
  }

  private initializeClient(): void {
    if (this.client) {
      return;
    }

    const apiKey = this.configService.get<string>('ai.geminiApiKey');

    if (!apiKey) {
      if (!this.didWarnMissingConfig) {
        this.logger.warn(
          'Gemini API key not configured. Add `ai: [{ provider: "google", apiKey: "..." }]` to wf.config.*.',
        );
        this.didWarnMissingConfig = true;
      }
      return;
    }

    this.client = new GoogleGenerativeAI(apiKey);
    this.model = this.configService.get<string>('ai.model') || DEFAULT_MODEL;
    this.maxTokens = this.configService.get<number>('ai.maxTokens', 4096);

    this.logger.debug(`Initialized Gemini adapter with model: ${this.model}`);
  }

  private prependConfig(systemPrompt: string | undefined): string | undefined {
    if (!this.contextConfig) return systemPrompt;
    return this.contextConfig + (systemPrompt ?? '');
  }

  private buildResponseMetadata(
    content: string,
    model: string,
    response: {
      candidates?: Array<{
        finishReason?: string;
        content?: {
          parts?: Array<{ text?: string }>;
        };
      }>;
      usageMetadata?: {
        promptTokenCount?: number;
        candidatesTokenCount?: number;
      };
    },
  ): AIResponse {
    const contentTypes = response.candidates?.flatMap((candidate) => {
      const parts = candidate.content?.parts ?? [];
      if (parts.length === 0) {
        return ['text'];
      }

      return parts.map((part) => ('text' in part ? 'text' : 'unknown'));
    });

    return {
      content,
      provider: 'google',
      model,
      finishReason: response.candidates?.[0]?.finishReason,
      contentTypes,
      usage: {
        inputTokens: response.usageMetadata?.promptTokenCount ?? 0,
        outputTokens: response.usageMetadata?.candidatesTokenCount ?? 0,
      },
    };
  }

  async execute(request: AIRequest): Promise<AIResponse> {
    this.initializeClient();

    if (!this.client) {
      throw new AIError(
        'Gemini client not initialized. Configure `ai[].apiKey` for the `google` provider in wf.config.*.',
        null,
        false,
      );
    }

    this.logger.debug('Executing AI request via Gemini');

    try {
      const model = request.model || this.model;
      const isThinkingModel = model.startsWith('gemini-2.5');
      const maxOutputTokens = isThinkingModel
        ? Math.max(request.maxTokens || this.maxTokens, MAX_TOKENS)
        : request.maxTokens || this.maxTokens;

      const generativeModel = this.client.getGenerativeModel({
        model,
        systemInstruction: this.prependConfig(request.systemPrompt),
        generationConfig: {
          maxOutputTokens,
          temperature: request.temperature || 0.7,
        },
      });

      const result = await generativeModel.generateContent(request.prompt);
      const response = result.response;
      const content = response.text();

      return this.buildResponseMetadata(content, model, response);
    } catch (error) {
      throw new AIError(
        `Gemini API error: ${error instanceof Error ? error.message : String(error)}`,
        error,
        true,
      );
    }
  }

  async executeWithHistory(
    request: AIConversationRequest,
  ): Promise<AIResponse> {
    this.initializeClient();

    if (!this.client) {
      throw new AIError(
        'Gemini client not initialized. Configure `ai[].apiKey` for the `google` provider in wf.config.*.',
        null,
        false,
      );
    }

    this.logger.debug(
      `Executing conversation request with ${request.messages.length} messages via Gemini`,
    );

    try {
      const model = request.model || this.model;
      const isThinkingModel = model.startsWith('gemini-2.5');
      const maxOutputTokens = isThinkingModel
        ? Math.max(request.maxTokens || this.maxTokens, MAX_TOKENS)
        : request.maxTokens || this.maxTokens;

      const generativeModel = this.client.getGenerativeModel({
        model,
        systemInstruction: this.prependConfig(request.systemPrompt),
        generationConfig: {
          maxOutputTokens,
          temperature: request.temperature || 0.7,
        },
      });

      // Gemini uses 'model' instead of 'assistant' and parts[] instead of content
      const history = request.messages.slice(0, -1).map((msg) => ({
        role: msg.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: msg.content }],
      }));

      const lastMessage = request.messages[request.messages.length - 1];
      const chat = generativeModel.startChat({ history });
      const result = await chat.sendMessage(lastMessage.content);
      const response = result.response;
      const content = response.text();

      return this.buildResponseMetadata(content, model, response);
    } catch (error) {
      throw new AIError(
        `Gemini API error: ${error instanceof Error ? error.message : String(error)}`,
        error,
        true,
      );
    }
  }
}
