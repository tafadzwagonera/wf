import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { BitBucketAdapter } from './bitbucket-adapter';
import { IssueTrackerConfigService } from '../issue-tracker-config.service';

/**
 * BitBucket issue tracker adapter module
 * Provides BitBucketAdapter for tracker-agnostic operations
 */
@Module({
  imports: [ConfigModule],
  providers: [BitBucketAdapter, IssueTrackerConfigService],
  exports: [BitBucketAdapter],
})
export class BitBucketIssueTrackerModule {}
