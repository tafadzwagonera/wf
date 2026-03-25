import { Module } from '@nestjs/common';
import { ConversationService } from './conversation.service';
import { ChatUIService } from './chat-ui.service';
import { ClaudeService } from '../claude.service';
import { LoggerService } from '../../../shared/logger/logger.service';
import { ConfigModule } from '@nestjs/config';
import { LlmAdapterFactory } from '../adapters/llm-adapter.factory';

/**
 * Module for interactive conversation features
 *
 * Provides services for multi-turn conversations with Claude,
 * including state management, persistence, and CLI UI.
 */
@Module({
  imports: [ConfigModule],
  providers: [
    LlmAdapterFactory,
    ClaudeService,
    ConversationService,
    ChatUIService,
    LoggerService,
  ],
  exports: [ConversationService, ChatUIService],
})
export class ConversationModule {}
