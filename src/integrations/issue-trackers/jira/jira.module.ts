import { Module } from '@nestjs/common';
import { JiraModule as ExistingJiraModule } from '../../jira/jira.module';
import { JiraAdapter } from './jira-adapter';

/**
 * Jira issue tracker adapter module
 * Provides JiraAdapter for tracker-agnostic operations
 */
@Module({
  imports: [ExistingJiraModule],
  providers: [JiraAdapter],
  exports: [JiraAdapter],
})
export class JiraIssueTrackerModule {}
