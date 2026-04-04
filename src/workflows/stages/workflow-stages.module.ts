import { Module } from '@nestjs/common';
import { AIModule } from '../../integrations/ai/ai.module';
import { PlatformModule } from '../../integrations/platforms/platform.module';
import { FetchStageService } from './fetch-stage.service';
import { PlanStageService } from './plan-stage.service';
import { ReviewStageService } from './review-stage.service';
import { CommitStageService } from './commit-stage.service';

@Module({
  imports: [AIModule, PlatformModule],
  providers: [
    FetchStageService,
    PlanStageService,
    ReviewStageService,
    CommitStageService,
  ],
  exports: [
    FetchStageService,
    PlanStageService,
    ReviewStageService,
    CommitStageService,
  ],
})
export class WorkflowStagesModule {}
