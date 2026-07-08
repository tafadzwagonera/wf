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
import { hasProviderUsageIntent } from './provider-intent';
import type { WfAiProviderConfig } from '../../../config/public-config';

@Injectable()
export class AnthropicAdapter implements LlmAdapter, OnModuleInit {
  private client?: Anthropic;
  private model = 'claude-sonnet-4-20250514';
  private maxTokens = 4096;
  private contextConfig = '';
  private didWarnMissingConfig = false;

  constructor(
    private configService: ConfigService,
    private logger: LoggerService
  ) {}

  async onModuleInit(): Promise<void> {
    const providers = this.configService.get<WfAiProviderConfig[]>('ai.providers') ?? [];

    this.contextConfig = await loadAiContextConfig(
      path.join(os.homedir(), '.claude', 'CLAUDE.md'),
      'CLAUDE.md',
      'anthropic',
      hasProviderUsageIntent(providers, 'anthropic')
    );
  }

  private initializeClient(): void {
    if (this.client) {
      return;
    }

    const apiKey = this.configService.get<string>('ai.anthropicApiKey');

    if (!apiKey) {
      if (!this.didWarnMissingConfig) {
        this.logger.warn(
          'Anthropic API key not configured. Add `ai: [{ provider: "anthropic", apiKey: "..." }]` to wf.config.*.'
        );
        this.didWarnMissingConfig = true;
      }
      return;
    }

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fetchImpl = globalThis.fetch ?? require('node-fetch');
    this.client = new Anthropic({ apiKey, fetch: fetchImpl });
    this.model = this.configService.get<string>('ai.model', 'claude-sonnet-4-20250514');

    this.logger.debug(`Initialized Anthropic adapter with model: ${this.model}`);
  }

  private prependConfig(systemPrompt: string | undefined): string | undefined {
    if (!this.contextConfig) return systemPrompt;
    return this.contextConfig + (systemPrompt ?? '');
  }

  /**
   * Anthropic adaptive-thinking-only models (Opus 4.7+, Sonnet 5+, Fable,
   * Mythos) reject non-default sampling parameters (temperature, top_p, top_k).
   * Passing any value causes a 400 error.
   */
  private isTemperatureRestricted(model: string): boolean {
    return /^claude-(opus-4-[7-9]|opus-[5-9]|sonnet-[5-9]|fable-|mythos-)/.test(model);
  }

  private extractContent(response: Anthropic.Messages.Message, model: string): AIResponse {
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
  }

  async execute(request: AIRequest): Promise<AIResponse> {
    this.initializeClient();

    if (!this.client) {
      throw new AIError(
        'Anthropic client not initialized. Configure `ai[].apiKey` for the `anthropic` provider in wf.config.*.',
        null,
        false
      );
    }

    this.logger.debug('Executing AI request via Anthropic');

    try {
      const model = request.model || this.model;
      const response = await this.client.messages.create({
        model,
        max_tokens: request.maxTokens || this.maxTokens,
        ...(this.isTemperatureRestricted(model) ? {} : { temperature: request.temperature ?? 0.7 }),
        system: this.prependConfig(request.systemPrompt),
        messages: [{ role: 'user', content: request.prompt }],
      });
      return this.extractContent(response, model);
    } catch (error) {
      if (error instanceof Anthropic.APIError) {
        throw new AIError(
          `Claude API error: ${error.message}`,
          {
            status: error.status,
          },
          true
        );
      }

      throw new AIError('Failed to execute AI request', error);
    }
  }

  async executeWithHistory(request: AIConversationRequest): Promise<AIResponse> {
    this.initializeClient();

    if (!this.client) {
      throw new AIError(
        'Anthropic client not initialized. Configure `ai[].apiKey` for the `anthropic` provider in wf.config.*.',
        null,
        false
      );
    }

    this.logger.debug(`Executing conversation request with ${request.messages.length} messages via Anthropic`);

    try {
      const model = request.model || this.model;
      const response = await this.client.messages.create({
        model,
        max_tokens: request.maxTokens || this.maxTokens,
        ...(this.isTemperatureRestricted(model) ? {} : { temperature: request.temperature ?? 0.7 }),
        system: this.prependConfig(request.systemPrompt),
        messages: request.messages,
      });
      return this.extractContent(response, model);
    } catch (error) {
      if (error instanceof Anthropic.APIError) {
        throw new AIError(
          `Claude API error: ${error.message}`,
          {
            status: error.status,
          },
          true
        );
      }

      throw new AIError('Failed to execute conversation request', error);
    }
  }
}
