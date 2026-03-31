import { Module } from '@nestjs/common';
import { AiService } from './ai.service';
import { ConversationModule } from './conversation/conversation.module';
import { LoggerService } from '../../shared/logger/logger.service';
import { LlmAdapterFactory } from './adapters/llm-adapter.factory';
import { AnthropicAdapter } from './adapters/anthropic.adapter';
import { OpenAIAdapter } from './adapters/openai.adapter';
import { GeminiAdapter } from './adapters/gemini.adapter';
import { DeepSeekAdapter } from './adapters/deepseek.adapter';

@Module({
  imports: [ConversationModule],
  providers: [
    AnthropicAdapter,
    OpenAIAdapter,
    GeminiAdapter,
    DeepSeekAdapter,
    LlmAdapterFactory,
    AiService,
    LoggerService,
  ],
  exports: [AiService, ConversationModule],
})
export class AIModule {}
