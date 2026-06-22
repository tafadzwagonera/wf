import { Injectable, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';
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

const DEFAULT_MODEL = 'gpt-4.1';

@Injectable()
export class OpenAIAdapter implements LlmAdapter, OnModuleInit {
  private client?: OpenAI;
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
      path.join(os.homedir(), '.openai', 'OPENAI.md'),
      '.openai/OPENAI.md',
      'openai',
      hasProviderUsageIntent(providers, 'openai'),
    );
  }

  private initializeClient(): void {
    if (this.client) {
      return;
    }

    const apiKey = this.configService.get<string>('ai.openaiApiKey');

    if (!apiKey) {
      if (!this.didWarnMissingConfig) {
        this.logger.warn(
          'OpenAI API key not configured. Add `ai: [{ provider: "openai", apiKey: "..." }]` to wf.config.*.',
        );
        this.didWarnMissingConfig = true;
      }
      return;
    }

    this.client = new OpenAI({ apiKey });
    this.model = this.configService.get<string>('ai.model') || DEFAULT_MODEL;

    this.logger.debug(`Initialized OpenAI adapter with model: ${this.model}`);
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

  /**
   * OpenAI reasoning models (o1, o3, o4, etc.) and frontier models (gpt-5,
   * gpt-5.5, etc.) only accept the default temperature value.
   * Passing any other value causes a 400 error.
   */
  private isTemperatureRestricted(model: string): boolean {
    return /^(o\d|gpt-5)/.test(model);
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
    this.initializeClient();

    if (!this.client) {
      throw new AIError(
        'OpenAI client not initialized. Configure `ai[].apiKey` for the `openai` provider in wf.config.*.',
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

      const model = request.model || this.model;
      const response = await this.client.chat.completions.create({
        model,
        max_completion_tokens: request.maxTokens || this.maxTokens,
        ...(this.isTemperatureRestricted(model)
          ? {}
          : { temperature: request.temperature || 0.7 }),
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
    this.initializeClient();

    if (!this.client) {
      throw new AIError(
        'OpenAI client not initialized. Configure `ai[].apiKey` for the `openai` provider in wf.config.*.',
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

      const model = request.model || this.model;
      const response = await this.client.chat.completions.create({
        model,
        max_completion_tokens: request.maxTokens || this.maxTokens,
        ...(this.isTemperatureRestricted(model)
          ? {}
          : { temperature: request.temperature || 0.7 }),
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
