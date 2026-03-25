import { Module } from '@nestjs/common';
import { AiService } from './ai.service';
import { ConversationModule } from './conversation/conversation.module';
import { LoggerService } from '../../shared/logger/logger.service';
import { LlmAdapterFactory } from './adapters/llm-adapter.factory';

@Module({
  imports: [ConversationModule],
  providers: [LlmAdapterFactory, AiService, LoggerService],
  exports: [AiService, ConversationModule],
})
export class AIModule {}
