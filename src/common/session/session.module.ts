import { Module } from '@nestjs/common';
import { AIModule } from '../../integrations/ai/ai.module';
import { SessionService } from './session.service';

@Module({
  imports: [AIModule],
  providers: [SessionService],
  exports: [SessionService],
})
export class SessionModule {}
