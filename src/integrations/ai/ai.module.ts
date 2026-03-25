import { Module } from '@nestjs/common';
import { ClaudeService } from './claude.service';
import { ConversationModule } from './conversation/conversation.module';
import { LoggerService } from '../../shared/logger/logger.service';
import { LlmAdapterFactory } from './adapters/llm-adapter.factory';

@Module({
  imports: [ConversationModule],
  providers: [LlmAdapterFactory, ClaudeService, LoggerService],
  exports: [ClaudeService, ConversationModule],
})
export class AIModule {}
