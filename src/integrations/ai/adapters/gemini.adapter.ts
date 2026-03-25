import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GoogleGenerativeAI } from '@google/generative-ai';
import type {
  AIConversationRequest,
  AIRequest,
  AIResponse,
} from '../claude.service';
import type { LlmAdapter } from '../llm-adapter.interface';
import { AIError } from '../../../shared/utils/errors';
import { LoggerService } from '../../../shared/logger/logger.service';

const DEFAULT_MODEL = 'gemini-2.5-pro';

// Arbitrarily chosen safe power of two (2^12). For gemini-2.5-* thinking
// models, maxOutputTokens is a shared budget covering both thinking tokens and
// response tokens — a low per-call override (e.g. 500) can be exhausted by
// thinking alone, leaving no tokens for the actual response. This floor
// ensures there is always room for output after thinking completes.
// Ref: https://ai.google.dev/gemini-api/docs/thinking
const MAX_TOKENS = 4096;

@Injectable()
export class GeminiAdapter implements LlmAdapter {
  private client: GoogleGenerativeAI;
  private model: string;
  private maxTokens: number;

  constructor(
    private configService: ConfigService,
    private logger: LoggerService,
  ) {
    const apiKey = this.configService.get<string>('ai.geminiApiKey');

    if (!apiKey) {
      this.logger.warn(
        'Gemini API key not configured. Set GEMINI_API_KEY in .env',
      );
    } else {
      this.client = new GoogleGenerativeAI(apiKey);
      this.model =
        this.configService.get<string>('ai.model') || DEFAULT_MODEL;
      this.maxTokens = this.configService.get<number>('ai.maxTokens', 4096);

      this.logger.debug(`Initialized Gemini adapter with model: ${this.model}`);
    }
  }

  async execute(request: AIRequest): Promise<AIResponse> {
    if (!this.client) {
      throw new AIError(
        'Gemini client not initialized. Set GEMINI_API_KEY in .env',
        null,
        false,
      );
    }

    this.logger.debug('Executing AI request via Gemini');

    try {
      const isThinkingModel = this.model.startsWith('gemini-2.5');
      const maxOutputTokens = isThinkingModel
        ? Math.max(request.maxTokens || this.maxTokens, MAX_TOKENS)
        : (request.maxTokens || this.maxTokens);

      const generativeModel = this.client.getGenerativeModel({
        model: this.model,
        systemInstruction: request.systemPrompt,
        generationConfig: {
          maxOutputTokens,
          temperature: request.temperature || 0.7,
        },
      });

      const result = await generativeModel.generateContent(request.prompt);
      const response = result.response;

      return {
        content: response.text(),
        usage: {
          inputTokens: response.usageMetadata?.promptTokenCount ?? 0,
          outputTokens: response.usageMetadata?.candidatesTokenCount ?? 0,
        },
      };
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
    if (!this.client) {
      throw new AIError(
        'Gemini client not initialized. Set GEMINI_API_KEY in .env',
        null,
        false,
      );
    }

    this.logger.debug(
      `Executing conversation request with ${request.messages.length} messages via Gemini`,
    );

    try {
      const isThinkingModel = this.model.startsWith('gemini-2.5');
      const maxOutputTokens = isThinkingModel
        ? Math.max(request.maxTokens || this.maxTokens, MAX_TOKENS)
        : (request.maxTokens || this.maxTokens);

      const generativeModel = this.client.getGenerativeModel({
        model: this.model,
        systemInstruction: request.systemPrompt,
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

      return {
        content: response.text(),
        usage: {
          inputTokens: response.usageMetadata?.promptTokenCount ?? 0,
          outputTokens: response.usageMetadata?.candidatesTokenCount ?? 0,
        },
      };
    } catch (error) {
      throw new AIError(
        `Gemini API error: ${error instanceof Error ? error.message : String(error)}`,
        error,
        true,
      );
    }
  }
}
