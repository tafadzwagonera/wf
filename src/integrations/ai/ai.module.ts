import { Module } from '@nestjs/common';
import { ClaudeService } from './claude.service';
import { ConversationModule } from './conversation/conversation.module';
import { LoggerService } from '../../shared/logger/logger.service';

@Module({
  imports: [ConversationModule],
  providers: [ClaudeService, LoggerService],
  exports: [ClaudeService, ConversationModule],
})
export class AIModule {}
