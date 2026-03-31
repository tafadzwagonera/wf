import { Module } from '@nestjs/common';
import { ConversationService } from './conversation.service';
import { ChatUIService } from './chat-ui.service';
import { AiService } from '../ai.service';
import { LoggerService } from '../../../shared/logger/logger.service';
import { ConfigModule } from '@nestjs/config';
import { LlmAdapterFactory } from '../adapters/llm-adapter.factory';
import { AnthropicAdapter } from '../adapters/anthropic.adapter';
import { OpenAIAdapter } from '../adapters/openai.adapter';
import { GeminiAdapter } from '../adapters/gemini.adapter';
import { DeepSeekAdapter } from '../adapters/deepseek.adapter';

/**
 * Module for interactive conversation features
 *
 * Provides services for multi-turn conversations with Claude,
 * including state management, persistence, and CLI UI.
 */
@Module({
  imports: [ConfigModule],
  providers: [
    AnthropicAdapter,
    OpenAIAdapter,
    GeminiAdapter,
    DeepSeekAdapter,
    LlmAdapterFactory,
    AiService,
    ConversationService,
    ChatUIService,
    LoggerService,
  ],
  exports: [ConversationService, ChatUIService],
})
export class ConversationModule {}
