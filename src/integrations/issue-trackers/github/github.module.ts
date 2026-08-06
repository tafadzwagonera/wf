import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { GitHubAdapter } from './github-adapter';
import { IssueTrackerConfigService } from '../issue-tracker-config.service';

/**
 * GitHub issue tracker adapter module
 * Provides GitHubAdapter for tracker-agnostic operations
 */
@Module({
  imports: [ConfigModule],
  providers: [GitHubAdapter, IssueTrackerConfigService],
  exports: [GitHubAdapter],
})
export class GitHubIssueTrackerModule {}
