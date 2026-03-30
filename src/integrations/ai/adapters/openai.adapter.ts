import { Injectable, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';
import type {
  AIConversationRequest,
  AIRequest,
  AIResponse,
} from '../ai.service';
import type { LlmAdapter } from '../llm-adapter.interface';
import { AIError } from '../../../shared/utils/errors';
import { LoggerService } from '../../../shared/logger/logger.service';
import { loadAiContextConfig } from './load-ai-context-config';

const DEFAULT_MODEL = 'gpt-4.1';

@Injectable()
export class OpenAIAdapter implements LlmAdapter, OnModuleInit {
  private client: OpenAI;
  private model: string;
  private maxTokens: number;
  private contextConfig = '';

  constructor(
    private configService: ConfigService,
    private logger: LoggerService,
  ) {
    const apiKey = this.configService.get<string>('ai.openaiApiKey');

    if (!apiKey) {
      this.logger.warn(
        'OpenAI API key not configured. Set OPENAI_API_KEY in .env',
      );
    } else {
      this.client = new OpenAI({ apiKey });
      this.model = this.configService.get<string>('ai.model') || DEFAULT_MODEL;
      this.maxTokens = this.configService.get<number>('ai.maxTokens', 4096);

      this.logger.debug(`Initialized OpenAI adapter with model: ${this.model}`);
    }
  }

  async onModuleInit(): Promise<void> {
    // No standard global config path exists for OpenAI; only project-level
    // OPENAI.md in process.cwd() is checked.
    this.contextConfig = await loadAiContextConfig(null, 'OPENAI.md', 'openai');
  }

  private prependConfig(systemPrompt: string | undefined): string | undefined {
    if (!this.contextConfig) return systemPrompt;
    return this.contextConfig + (systemPrompt ?? '');
  }

  private buildMessages(
    messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
  ): OpenAI.Chat.ChatCompletionMessageParam[] {
    return messages.map((message) => ({
      role: message.role,
      content: message.content,
    }));
  }

  private getApiErrorDetails(error: unknown): { status?: number } {
    return typeof error === 'object' &&
      error !== null &&
      'status' in error &&
      typeof error.status === 'number'
      ? { status: error.status }
      : {};
  }

  async execute(request: AIRequest): Promise<AIResponse> {
    if (!this.client) {
      throw new AIError(
        'OpenAI client not initialized. Set OPENAI_API_KEY in .env',
        null,
        false,
      );
    }

    this.logger.debug('Executing AI request via OpenAI');

    try {
      const messages: Array<{
        role: 'system' | 'user' | 'assistant';
        content: string;
      }> = [];

      const systemPrompt = this.prependConfig(request.systemPrompt);
      if (systemPrompt) {
        messages.push({ role: 'system', content: systemPrompt });
      }

      messages.push({ role: 'user', content: request.prompt });

      const response = await this.client.chat.completions.create({
        model: this.model,
        max_completion_tokens: request.maxTokens || this.maxTokens,
        temperature: request.temperature || 0.7,
        messages: this.buildMessages(messages),
      });

      return {
        content: response.choices[0].message.content ?? '',
        usage: {
          inputTokens: response.usage?.prompt_tokens ?? 0,
          outputTokens: response.usage?.completion_tokens ?? 0,
        },
      };
    } catch (error) {
      if (error instanceof OpenAI.APIError) {
        throw new AIError(
          `OpenAI API error: ${error.message}`,
          this.getApiErrorDetails(error),
          true,
        );
      }

      throw new AIError('Failed to execute AI request', error);
    }
  }

  async executeWithHistory(
    request: AIConversationRequest,
  ): Promise<AIResponse> {
    if (!this.client) {
      throw new AIError(
        'OpenAI client not initialized. Set OPENAI_API_KEY in .env',
        null,
        false,
      );
    }

    this.logger.debug(
      `Executing conversation request with ${request.messages.length} messages via OpenAI`,
    );

    try {
      const messages: Array<{
        role: 'system' | 'user' | 'assistant';
        content: string;
      }> = [];

      const systemPrompt = this.prependConfig(request.systemPrompt);
      if (systemPrompt) {
        messages.push({ role: 'system', content: systemPrompt });
      }

      for (const message of request.messages) {
        messages.push({ role: message.role, content: message.content });
      }

      const response = await this.client.chat.completions.create({
        model: this.model,
        max_completion_tokens: request.maxTokens || this.maxTokens,
        temperature: request.temperature || 0.7,
        messages: this.buildMessages(messages),
      });

      return {
        content: response.choices[0].message.content ?? '',
        usage: {
          inputTokens: response.usage?.prompt_tokens ?? 0,
          outputTokens: response.usage?.completion_tokens ?? 0,
        },
      };
    } catch (error) {
      if (error instanceof OpenAI.APIError) {
        throw new AIError(
          `OpenAI API error: ${error.message}`,
          this.getApiErrorDetails(error),
          true,
        );
      }

      throw new AIError('Failed to execute conversation request', error);
    }
  }
}
