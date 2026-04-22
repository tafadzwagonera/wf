import { Module } from '@nestjs/common';
import { AiService } from './ai.service';
import { ConversationModule } from './conversation/conversation.module';
import { LoggerService } from '../../shared/logger/logger.service';
import { LlmAdapterFactory } from './adapters/llm-adapter.factory';
import { AnthropicAdapter } from './adapters/anthropic.adapter';
import { OpenAIAdapter } from './adapters/openai.adapter';
import { GeminiAdapter } from './adapters/gemini.adapter';
import { DeepSeekAdapter } from './adapters/deepseek.adapter';
import { StageAgentService } from './stage-agent.service';

@Module({
  imports: [ConversationModule],
  providers: [
    AnthropicAdapter,
    OpenAIAdapter,
    GeminiAdapter,
    DeepSeekAdapter,
    LlmAdapterFactory,
    AiService,
    StageAgentService,
    LoggerService,
  ],
  exports: [AiService, StageAgentService, ConversationModule],
})
export class AIModule {}
