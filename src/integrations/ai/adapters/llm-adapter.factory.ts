import { ConfigService } from '@nestjs/config';
import { LLM_ADAPTER } from '../llm-adapter.interface';
import type { LlmAdapter } from '../llm-adapter.interface';
import { LoggerService } from '../../../shared/logger/logger.service';
import { AnthropicAdapter } from './anthropic.adapter';
import { GeminiAdapter } from './gemini.adapter';
import { DeepSeekAdapter } from './deepseek.adapter';
import { OpenAIAdapter } from './openai.adapter';

export const LlmAdapterFactory = {
  provide: LLM_ADAPTER,
  useFactory: (
    configService: ConfigService,
    logger: LoggerService,
  ): LlmAdapter => {
    const provider = configService.get<string>('ai.provider', 'anthropic');

    switch (provider) {
      case 'openai':
        return new OpenAIAdapter(configService, logger);
      case 'gemini':
        return new GeminiAdapter(configService, logger);
      case 'deepseek':
        return new DeepSeekAdapter(configService, logger);
      default:
        return new AnthropicAdapter(configService, logger);
    }
  },
  inject: [ConfigService, LoggerService],
};
