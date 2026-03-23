import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { BitBucketAdapter } from './bitbucket-adapter';
import { LoggerService } from '../../../shared/logger/logger.service';
import { PlatformConfigService } from '../platform-config.service';

/**
 * BitBucket platform adapter module
 * Provides BitBucketAdapter for platform-agnostic operations
 */
@Module({
  imports: [ConfigModule],
  providers: [BitBucketAdapter, LoggerService, PlatformConfigService],
  exports: [BitBucketAdapter],
})
export class BitBucketPlatformModule {}
