import { Module } from '@nestjs/common';
import { AIModule } from '../integrations/ai/ai.module';
import { PlatformModule } from '../integrations/platforms/platform.module';
import { GitModule } from '../integrations/git/git.module';
import { FetcherAgent } from './fetcher.agent';
import { PlannerAgent } from './planner.agent';
import { ImplementerAgent } from './implementer.agent';
import { ReviewerAgent } from './reviewer.agent';
import { CommitterAgent } from './committer.agent';
import { AgentOrchestrator } from './agent-orchestrator.service';

@Module({
  // Re-importing AIModule, PlatformModule, GitModule here is correct NestJS practice.
  // NestJS deduplicates providers per module scope — no double-registration occurs.
  // ConfigModule is global; do NOT import it here.
  imports: [AIModule, PlatformModule, GitModule],
  providers: [
    FetcherAgent,
    PlannerAgent,
    ImplementerAgent,
    ReviewerAgent,
    CommitterAgent,
    AgentOrchestrator,
  ],
  exports: [AgentOrchestrator],
})
export class AgentsModule {}
