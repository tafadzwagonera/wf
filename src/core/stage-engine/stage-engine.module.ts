import { Module } from '@nestjs/common';
import { StageEngineService } from './stage-engine.service';
import { BashExecutor } from './action-executors/bash-executor';
import { AIExecutor } from './action-executors/ai-executor';
import { JiraExecutor } from './action-executors/jira-executor';
import { GitExecutor } from './action-executors/git-executor';
import { FileExecutor } from './action-executors/file-executor';
import { LoggerService } from '../../shared/logger/logger.service';
import { JiraModule } from '../../integrations/jira/jira.module';
import { GitModule } from '../../integrations/git/git.module';
import { AIModule } from '../../integrations/ai/ai.module';
import { StateManagerModule } from '../state-manager/state-manager.module';
import { ApprovalSystemModule } from '../approval-system/approval-system.module';

@Module({
  imports: [
    JiraModule,
    GitModule,
    AIModule,
    StateManagerModule,
    ApprovalSystemModule,
  ],
  providers: [
    StageEngineService,
    BashExecutor,
    AIExecutor,
    JiraExecutor,
    GitExecutor,
    FileExecutor,
    LoggerService,
  ],
  exports: [
    StageEngineService,
    BashExecutor,
    AIExecutor,
    JiraExecutor,
    GitExecutor,
    FileExecutor,
  ],
})
export class StageEngineModule {}
