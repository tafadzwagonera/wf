import { Module } from '@nestjs/common';
import { RunCommand } from './run.command';
import { ListCommand } from './list.command';
import { ResumeCommand } from './resume.command';
import { HistoryCommand } from './history.command';
import {
  ConfigCommand,
  ConfigGetCommand,
  ConfigSetCommand,
  ConfigListCommand,
} from './config.command';
import { IssueCreateCommand } from './issue-create.command';
import { IssueFetchCommand } from './issue-fetch.command';
import { IssuePlanCommand } from './issue-plan.command';
import { IssueImplementCommand } from './issue-implement.command';
import { IssueReviewCommand } from './issue-review.command';
import { IssueCommand } from './issue.command';
import { IssueGenerateCommand } from './issue-generate.command';
import { IssueCommitCommand } from './issue-commit.command';
import { IssuePrCommand } from './issue-pr.command';
import { IssueCowsayCommand } from './issue-cowsay.command';
import { AgentsModule } from '../agents/agents.module';
import { WorkflowParserModule } from '../core/workflow-parser/workflow-parser.module';
import { StageEngineModule } from '../core/stage-engine/stage-engine.module';
import { StateManagerModule } from '../core/state-manager/state-manager.module';
import { JiraModule } from '../integrations/jira/jira.module';
import { GitModule } from '../integrations/git/git.module';
import { AIModule } from '../integrations/ai/ai.module';
import { PlatformModule } from '../integrations/platforms/platform.module';
import { ConvertersModule } from '../common/converters/converters.module';
import { LoggerService } from '../shared/logger/logger.service';
import { DryRunPreviewService } from '../shared/preview/dry-run-preview.service';
import { SlackService } from '../integrations/slack/slack.service';
import { WorkflowStagesModule } from '../workflows/stages/workflow-stages.module';

@Module({
  imports: [
    AgentsModule,
    WorkflowParserModule,
    StageEngineModule,
    StateManagerModule,
    JiraModule,
    GitModule,
    AIModule,
    PlatformModule,
    ConvertersModule,
    WorkflowStagesModule,
  ],
  providers: [
    RunCommand,
    ListCommand,
    ResumeCommand,
    HistoryCommand,
    ConfigCommand,
    ConfigGetCommand,
    ConfigSetCommand,
    ConfigListCommand,
    IssueCreateCommand,
    IssueFetchCommand,
    IssuePlanCommand,
    IssueImplementCommand,
    IssueReviewCommand,
    IssueCommand,
    IssueGenerateCommand,
    IssueCommitCommand,
    IssuePrCommand,
    IssueCowsayCommand,
    LoggerService,
    DryRunPreviewService,
    SlackService,
  ],
})
export class CommandsModule {}
