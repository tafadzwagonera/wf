import { Module } from '@nestjs/common';
import { AIModule } from '../integrations/ai/ai.module';
import { IssueTrackerModule } from '../integrations/issue-trackers/issue-tracker.module';
import { GitModule } from '../integrations/git/git.module';
import { FetcherAgent } from './fetcher.agent';
import { PlannerAgent } from './planner.agent';
import { ImplementerAgent } from './implementer.agent';
import { ReviewerAgent } from './reviewer.agent';
import { CommitterAgent } from './committer.agent';
import { AgentOrchestrator } from './agent-orchestrator.service';
import { WorkflowStagesModule } from '../workflows/stages/workflow-stages.module';
import { ReviewModule } from '../review/review.module';
import { PlanStepVerificationService } from './plan-step-verification.service';
import { StepSpecFidelityService } from './step-spec-fidelity.service';
import { PullStepAssessorService } from './pull-step-assessor.service';

@Module({
  // Re-importing AIModule, IssueTrackerModule, GitModule here is correct NestJS practice.
  // NestJS deduplicates providers per module scope — no double-registration occurs.
  // ConfigModule is global; do NOT import it here.
  imports: [AIModule, IssueTrackerModule, GitModule, WorkflowStagesModule, ReviewModule],
  providers: [
    FetcherAgent, PlannerAgent, ImplementerAgent, ReviewerAgent, CommitterAgent,
    AgentOrchestrator, PlanStepVerificationService, StepSpecFidelityService, PullStepAssessorService,
  ],
  exports: [AgentOrchestrator],
})
export class AgentsModule {}
