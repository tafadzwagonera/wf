import { Module } from '@nestjs/common';
import { AIModule } from '../../integrations/ai/ai.module';
import { IssueTrackerModule } from '../../integrations/issue-trackers/issue-tracker.module';
import { FetchStageService } from './fetch-stage.service';
import { PlanStageService } from './plan-stage.service';
import { ReviewStageService } from './review-stage.service';
import { CommitStageService } from './commit-stage.service';
import { CommitDescriptionStageService } from './commit-description-stage.service';

@Module({
  imports: [AIModule, IssueTrackerModule],
  providers: [
    FetchStageService, PlanStageService, ReviewStageService, CommitStageService, CommitDescriptionStageService,
  ],
  exports: [
    FetchStageService, PlanStageService, ReviewStageService, CommitStageService, CommitDescriptionStageService,
  ],
})
export class WorkflowStagesModule {}
