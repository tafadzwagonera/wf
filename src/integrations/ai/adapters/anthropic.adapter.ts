import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Anthropic from '@anthropic-ai/sdk';
import type {
  AIConversationRequest,
  AIRequest,
  AIResponse,
} from '../claude.service';
import type { LlmAdapter } from '../llm-adapter.interface';
import { AIError } from '../../../shared/utils/errors';
import { LoggerService } from '../../../shared/logger/logger.service';

@Injectable()
export class AnthropicAdapter implements LlmAdapter {
  private client: Anthropic;
  private model: string;
  private maxTokens: number;

  constructor(
    private configService: ConfigService,
    private logger: LoggerService,
  ) {
    const apiKey = this.configService.get<string>('ai.apiKey');

    if (!apiKey) {
      this.logger.warn(
        'Anthropic API key not configured. Set ANTHROPIC_API_KEY in .env',
      );
    } else {
      this.client = new Anthropic({ apiKey });
      this.model = this.configService.get<string>(
        'ai.model',
        'claude-sonnet-4-20250514',
      );
      this.maxTokens = this.configService.get<number>('ai.maxTokens', 4096);

      this.logger.debug(
        `Initialized Anthropic adapter with model: ${this.model}`,
      );
    }
  }

  async execute(request: AIRequest): Promise<AIResponse> {
    if (!this.client) {
      throw new AIError(
        'Anthropic client not initialized. Set ANTHROPIC_API_KEY in .env',
        null,
        false,
      );
    }

    this.logger.debug('Executing AI request via Anthropic');

    try {
      const response = await this.client.messages.create({
        model: this.model,
        max_tokens: request.maxTokens || this.maxTokens,
        temperature: request.temperature || 0.7,
        system: request.systemPrompt,
        messages: [{ role: 'user', content: request.prompt }],
      });

      const content =
        response.content[0].type === 'text' ? response.content[0].text : '';

      return {
        content,
        usage: {
          inputTokens: response.usage.input_tokens,
          outputTokens: response.usage.output_tokens,
        },
      };
    } catch (error) {
      if (error instanceof Anthropic.APIError) {
        throw new AIError(`Claude API error: ${error.message}`, {
          status: error.status,
        }, true);
      }

      throw new AIError('Failed to execute AI request', error);
    }
  }

  async executeWithHistory(
    request: AIConversationRequest,
  ): Promise<AIResponse> {
    if (!this.client) {
      throw new AIError(
        'Anthropic client not initialized. Set ANTHROPIC_API_KEY in .env',
        null,
        false,
      );
    }

    this.logger.debug(
      `Executing conversation request with ${request.messages.length} messages via Anthropic`,
    );

    try {
      const response = await this.client.messages.create({
        model: this.model,
        max_tokens: request.maxTokens || this.maxTokens,
        temperature: request.temperature || 0.7,
        system: request.systemPrompt,
        messages: request.messages,
      });

      const content =
        response.content[0].type === 'text' ? response.content[0].text : '';

      return {
        content,
        usage: {
          inputTokens: response.usage.input_tokens,
          outputTokens: response.usage.output_tokens,
        },
      };
    } catch (error) {
      if (error instanceof Anthropic.APIError) {
        throw new AIError(`Claude API error: ${error.message}`, {
          status: error.status,
        }, true);
      }

      throw new AIError('Failed to execute conversation request', error);
    }
  }
}
