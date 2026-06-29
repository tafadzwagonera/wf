import { Module } from '@nestjs/common';
import { AIModule } from '../../integrations/ai/ai.module';
import { SessionService } from './session.service';
import { SummaryService } from './summary.service';

@Module({
  imports: [AIModule],
  providers: [SessionService, SummaryService],
  exports: [SessionService, SummaryService],
})
export class SessionModule {}
