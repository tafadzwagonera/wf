import { Injectable } from '@nestjs/common';
import { FetcherAgent } from './fetcher.agent';
import { PlannerAgent } from './planner.agent';
import { ImplementerAgent } from './implementer.agent';
import { ReviewerAgent } from './reviewer.agent';
import { CommitterAgent } from './committer.agent';

@Injectable()
export class AgentOrchestrator {
  constructor(
    readonly fetcher: FetcherAgent,
    readonly planner: PlannerAgent,
    readonly implementer: ImplementerAgent,
    readonly reviewer: ReviewerAgent,
    readonly committer: CommitterAgent
  ) {}
}
