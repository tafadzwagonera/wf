import { Module, OnModuleInit } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PlatformService } from './platform.service';
import { PlatformConfigService } from './platform-config.service';
import { JiraPlatformModule } from './jira/jira.module';
import { GitHubPlatformModule } from './github/github.module';
import { BitBucketPlatformModule } from './bitbucket/bitbucket.module';
import { JiraAdapter } from './jira/jira-adapter';
import { GitHubAdapter } from './github/github-adapter';
import { BitBucketAdapter } from './bitbucket/bitbucket-adapter';

/**
 * Main platform module that registers all platform adapters
 * Provides centralized access to different ticket platforms
 */
@Module({
  imports: [
    ConfigModule,
    JiraPlatformModule,
    GitHubPlatformModule,
    BitBucketPlatformModule,
  ],
  providers: [PlatformService, PlatformConfigService],
  exports: [PlatformService, PlatformConfigService],
})
export class PlatformModule implements OnModuleInit {
  constructor(
    private readonly platformService: PlatformService,
    private readonly jiraAdapter: JiraAdapter,
    private readonly githubAdapter: GitHubAdapter,
    private readonly bitbucketAdapter: BitBucketAdapter,
  ) {}

  /**
   * Register all platform adapters when module initializes
   */
  onModuleInit() {
    this.platformService.registerAdapter(this.jiraAdapter);
    this.platformService.registerAdapter(this.githubAdapter);
    this.platformService.registerAdapter(this.bitbucketAdapter);
  }
}
