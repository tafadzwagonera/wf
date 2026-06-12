import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { GitHubAdapter } from './github-adapter';
import { LoggerService } from '../../../shared/logger/logger.service';
import { IssueTrackerConfigService } from '../issue-tracker-config.service';

/**
 * GitHub issue tracker adapter module
 * Provides GitHubAdapter for tracker-agnostic operations
 */
@Module({
  imports: [ConfigModule],
  providers: [GitHubAdapter, LoggerService, IssueTrackerConfigService],
  exports: [GitHubAdapter],
})
export class GitHubIssueTrackerModule {}
