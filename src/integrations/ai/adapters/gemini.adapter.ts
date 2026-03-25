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
      const generativeModel = this.client.getGenerativeModel({
        model: this.model,
        systemInstruction: request.systemPrompt,
        generationConfig: {
          maxOutputTokens: request.maxTokens || this.maxTokens,
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
      const generativeModel = this.client.getGenerativeModel({
        model: this.model,
        systemInstruction: request.systemPrompt,
        generationConfig: {
          maxOutputTokens: request.maxTokens || this.maxTokens,
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
