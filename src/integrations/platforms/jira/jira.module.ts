import { Module } from '@nestjs/common';
import { JiraModule as ExistingJiraModule } from '../../jira/jira.module';
import { JiraAdapter } from './jira-adapter';

/**
 * Jira platform adapter module
 * Provides JiraAdapter for platform-agnostic operations
 */
@Module({
  imports: [ExistingJiraModule],
  providers: [JiraAdapter],
  exports: [JiraAdapter],
})
export class JiraPlatformModule {}
