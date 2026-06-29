import { Module } from '@nestjs/common';
import { ConfigCommand, ConfigGetCommand, ConfigSetCommand, ConfigListCommand } from './config.command';
import { ConfigCleanCommand } from './config-clean.command';
import { IssueCreateCommand } from './issue-create.command';
import { IssueFetchCommand } from './issue-fetch.command';
import { IssuePlanCommand } from './issue-plan.command';
import { IssueImplementCommand } from './issue-implement.command';
import { IssueReviewCommand } from './issue-review.command';
import { IssueCommand } from './issue.command';
import { IssueGenerateCommand } from './issue-generate.command';
import { IssueGenerateLookupCommand } from './issue-generate-lookup.command';
import { IssueCommitCommand } from './issue-commit.command';
import { IssuePrCommand } from './issue-pr.command';
import { IssueCowsayCommand } from './issue-cowsay.command';
import { AgentsModule } from '../agents/agents.module';
import { JiraModule } from '../integrations/jira/jira.module';
import { GitModule } from '../integrations/git/git.module';
import { AIModule } from '../integrations/ai/ai.module';
import { IssueTrackerModule } from '../integrations/issue-trackers/issue-tracker.module';
import { ConvertersModule } from '../common/converters/converters.module';
import { LoggerService } from '../shared/logger/logger.service';
import { DryRunPreviewService } from '../shared/preview/dry-run-preview.service';
import { SlackService } from '../integrations/slack/slack.service';
import { WorkflowStagesModule } from '../workflows/stages/workflow-stages.module';
import { SessionModule } from '../shared/session/session.module';

@Module({
  imports: [
    AgentsModule,
    JiraModule,
    GitModule,
    AIModule,
    IssueTrackerModule,
    ConvertersModule,
    WorkflowStagesModule,
    SessionModule,
  ],
  providers: [
    ConfigCommand,
    ConfigGetCommand,
    ConfigSetCommand,
    ConfigListCommand,
    ConfigCleanCommand,
    IssueCreateCommand,
    IssueFetchCommand,
    IssuePlanCommand,
    IssueImplementCommand,
    IssueReviewCommand,
    IssueCommand,
    IssueGenerateCommand,
    IssueGenerateLookupCommand,
    IssueCommitCommand,
    IssuePrCommand,
    IssueCowsayCommand,
    LoggerService,
    DryRunPreviewService,
    SlackService,
  ],
})
export class CommandsModule {}
