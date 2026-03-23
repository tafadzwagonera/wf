import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * Service for managing platform configuration
 *
 * Determines which platforms are enabled and should show warnings
 * based on explicit configuration or auto-detection
 */
@Injectable()
export class PlatformConfigService {
  private enabledPlatforms: Set<string> | undefined;

  constructor(private configService: ConfigService) {
    const enabled = this.configService.get<string[]>('platforms.enabled');
    this.enabledPlatforms = enabled ? new Set(enabled) : undefined;
  }

  /**
   * Check if a platform is enabled
   * Returns true if:
   * 1. Platform is explicitly listed in ENABLED_PLATFORMS, OR
   * 2. ENABLED_PLATFORMS is not set AND platform has any config variables set
   *
   * @param platform - Platform name (jira, github, bitbucket)
   * @param hasPartialConfig - Whether the platform has any configuration set
   * @returns True if platform is enabled
   */
  isPlatformEnabled(
    platform: 'jira' | 'github' | 'bitbucket',
    hasPartialConfig: boolean = false,
  ): boolean {
    // Explicit configuration takes precedence
    if (this.enabledPlatforms !== undefined) {
      return this.enabledPlatforms.has(platform);
    }

    // Auto-detect: only enable if user has set some config for this platform
    return hasPartialConfig;
  }

  /**
   * Check if platform should show configuration warnings
   *
   * @param platform - Platform name
   * @returns True if warnings should be shown
   */
  shouldWarnForPlatform(platform: 'jira' | 'github' | 'bitbucket'): boolean {
    return this.isPlatformEnabled(platform);
  }
}
