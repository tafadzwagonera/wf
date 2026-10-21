import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import configuration from './config/configuration';
import { JiraModule } from './integrations/jira/jira.module';
import { GitModule } from './integrations/git/git.module';
import { AIModule } from './integrations/ai/ai.module';
import { CommandsModule } from './commands/commands.module';
import { ConvertersModule } from './common/converters/converters.module';
import { IssueTrackerModule } from './integrations/issue-trackers/issue-tracker.module';
import { LoggerModule } from './common/logger/logger.module';
import { PresentationModule } from './common/presentation/presentation.module';
import { SessionModule } from './common/session/session.module';

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
    LoggerModule,
    PresentationModule,
    CommandsModule,
    ConvertersModule,
    IssueTrackerModule,
    SessionModule,
  ],
  controllers: [],
  providers: [],
})
export class AppModule {}
