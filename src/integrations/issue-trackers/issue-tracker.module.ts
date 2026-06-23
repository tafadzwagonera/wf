import { Module, OnModuleInit } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { IssueTrackerService } from './issue-tracker.service';
import { IssueTrackerConfigService } from './issue-tracker-config.service';
import { JiraIssueTrackerModule } from './jira/jira.module';
import { GitHubIssueTrackerModule } from './github/github.module';
import { BitBucketIssueTrackerModule } from './bitbucket/bitbucket.module';
import { JiraAdapter } from './jira/jira-adapter';
import { GitHubAdapter } from './github/github-adapter';
import { BitBucketAdapter } from './bitbucket/bitbucket-adapter';

/**
 * Main issue tracker module that registers all tracker adapters
 * Provides centralized access to different ticket trackers
 */
@Module({
  imports: [ConfigModule, JiraIssueTrackerModule, GitHubIssueTrackerModule, BitBucketIssueTrackerModule],
  providers: [IssueTrackerService, IssueTrackerConfigService],
  exports: [IssueTrackerService, IssueTrackerConfigService, JiraIssueTrackerModule],
})
export class IssueTrackerModule implements OnModuleInit {
  constructor(
    private readonly issueTrackerService: IssueTrackerService,
    private readonly jiraAdapter: JiraAdapter,
    private readonly githubAdapter: GitHubAdapter,
    private readonly bitbucketAdapter: BitBucketAdapter
  ) {}

  /**
   * Register all tracker adapters when module initializes
   */
  onModuleInit() {
    this.issueTrackerService.registerAdapter(this.jiraAdapter);
    this.issueTrackerService.registerAdapter(this.githubAdapter);
    this.issueTrackerService.registerAdapter(this.bitbucketAdapter);
  }
}
