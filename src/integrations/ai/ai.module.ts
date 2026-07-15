import { Module } from '@nestjs/common';
import { AiService } from './ai.service';
import { LoggerService } from '../../shared/logger/logger.service';
import { LlmAdapterFactory } from './adapters/llm-adapter.factory';
import { AnthropicAdapter } from './adapters/anthropic.adapter';
import { OpenAIAdapter } from './adapters/openai.adapter';
import { GeminiAdapter } from './adapters/gemini.adapter';
import { DeepSeekAdapter } from './adapters/deepseek.adapter';
import { StageAgentService } from './stage-agent.service';
import { ConversationService } from './conversation/conversation.service';
import { ChatUIService } from './conversation/chat-ui.service';

@Module({
  providers: [
    AnthropicAdapter,
    OpenAIAdapter,
    GeminiAdapter,
    DeepSeekAdapter,
    LlmAdapterFactory,
    AiService,
    StageAgentService,
    LoggerService,
    ConversationService,
    ChatUIService,
  ],
  exports: [AiService, StageAgentService, ConversationService, ChatUIService],
})
export class AIModule {}
