import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import configuration from './config/configuration';
import { JiraModule } from './integrations/jira/jira.module';
import { GitModule } from './integrations/git/git.module';
import { AIModule } from './integrations/ai/ai.module';
import { WorkflowParserModule } from './core/workflow-parser/workflow-parser.module';
import { StateManagerModule } from './core/state-manager/state-manager.module';
import { ApprovalSystemModule } from './core/approval-system/approval-system.module';
import { StageEngineModule } from './core/stage-engine/stage-engine.module';
import { CommandsModule } from './commands/commands.module';
import { ConvertersModule } from './common/converters/converters.module';
import { PlatformModule } from './integrations/platforms/platform.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      ignoreEnvFile: true,
      load: [configuration],
    }),
    JiraModule,
    GitModule,
    AIModule,
    WorkflowParserModule,
    StateManagerModule,
    ApprovalSystemModule,
    StageEngineModule,
    CommandsModule,
    ConvertersModule,
    PlatformModule,
  ],
  controllers: [],
  providers: [],
})
export class AppModule {}
