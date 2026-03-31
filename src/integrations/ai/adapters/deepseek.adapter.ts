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

const DEFAULT_MODEL = 'deepseek-reasoner';
const DEEPSEEK_BASE_URL = 'https://api.deepseek.com/v1';

@Injectable()
export class DeepSeekAdapter implements LlmAdapter, OnModuleInit {
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
      path.join(os.homedir(), '.deepseek', 'DEEPSEEK.md'),
      'DEEPSEEK.md',
      'deepseek',
      hasProviderUsageIntent(providers, 'deepseek'),
    );
  }

  private initializeClient(): void {
    if (this.client) {
      return;
    }

    const apiKey = this.configService.get<string>('ai.deepseekApiKey');

    if (!apiKey) {
      if (!this.didWarnMissingConfig) {
        this.logger.warn(
          'DeepSeek API key not configured. Add `ai: [{ provider: "deepseek", apiKey: "..." }]` to wf.config.*.',
        );
        this.didWarnMissingConfig = true;
      }
      return;
    }

    this.client = new OpenAI({ apiKey, baseURL: DEEPSEEK_BASE_URL });
    this.model = this.configService.get<string>('ai.model') || DEFAULT_MODEL;

    this.logger.debug(`Initialized DeepSeek adapter with model: ${this.model}`);
  }

  private prependConfig(systemPrompt: string | undefined): string | undefined {
    if (!this.contextConfig) return systemPrompt;
    return this.contextConfig + (systemPrompt ?? '');
  }

  async execute(request: AIRequest): Promise<AIResponse> {
    this.initializeClient();

    if (!this.client) {
      throw new AIError(
        'DeepSeek client not initialized. Configure `ai[].apiKey` for the `deepseek` provider in wf.config.*.',
        null,
        false,
      );
    }

    this.logger.debug('Executing AI request via DeepSeek');

    try {
      const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [];

      const systemPrompt = this.prependConfig(request.systemPrompt);
      if (systemPrompt) {
        messages.push({ role: 'system', content: systemPrompt });
      }

      messages.push({ role: 'user', content: request.prompt });

      const response = await this.client.chat.completions.create({
        model: request.model || this.model,
        max_tokens: request.maxTokens || this.maxTokens,
        temperature: request.temperature || 0.7,
        messages,
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
          `DeepSeek API error: ${error.message}`,
          {
            status: error.status,
          },
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
        'DeepSeek client not initialized. Configure `ai[].apiKey` for the `deepseek` provider in wf.config.*.',
        null,
        false,
      );
    }

    this.logger.debug(
      `Executing conversation request with ${request.messages.length} messages via DeepSeek`,
    );

    try {
      const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [];

      const systemPrompt = this.prependConfig(request.systemPrompt);
      if (systemPrompt) {
        messages.push({ role: 'system', content: systemPrompt });
      }

      for (const msg of request.messages) {
        messages.push({ role: msg.role, content: msg.content });
      }

      const response = await this.client.chat.completions.create({
        model: request.model || this.model,
        max_tokens: request.maxTokens || this.maxTokens,
        temperature: request.temperature || 0.7,
        messages,
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
          `DeepSeek API error: ${error.message}`,
          {
            status: error.status,
          },
          true,
        );
      }

      throw new AIError('Failed to execute conversation request', error);
    }
  }
}
