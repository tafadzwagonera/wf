import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { GitHubAdapter } from './github-adapter';
import { LoggerService } from '../../../shared/logger/logger.service';
import { PlatformConfigService } from '../platform-config.service';

/**
 * GitHub platform adapter module
 * Provides GitHubAdapter for platform-agnostic operations
 */
@Module({
  imports: [ConfigModule],
  providers: [GitHubAdapter, LoggerService, PlatformConfigService],
  exports: [GitHubAdapter],
})
export class GitHubPlatformModule {}
