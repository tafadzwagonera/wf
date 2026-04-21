import { Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PlatformAdapter } from './platform-adapter.interface';

/**
 * Factory service for managing and retrieving platform adapters.
 * Provides centralized access to different platform implementations.
 */
@Injectable()
export class PlatformService {
  private adapters: Map<string, PlatformAdapter> = new Map();

  constructor(private readonly configService: ConfigService) {}

  /**
   * Register a platform adapter
   * @param adapter Platform adapter instance to register
   */
  registerAdapter(adapter: PlatformAdapter): void {
    const platformName = adapter.getPlatformName();
    this.adapters.set(platformName, adapter);
  }

  /**
   * Get an adapter for a specific platform
   * @param platformName Platform identifier (e.g., "jira", "github", "bitbucket")
   * @returns Platform adapter instance
   * @throws NotFoundException if platform is not registered
   */
  getAdapter(platformName?: string): PlatformAdapter {
    const platform =
      platformName ||
      this.configService.get<string>('platforms.primary', 'jira');

    const adapter = this.adapters.get(platform);
    if (!adapter) {
      throw new NotFoundException(
        `Platform adapter not found for: ${platform}. Available platforms: ${this.getAvailablePlatforms().join(', ')}`,
      );
    }

    return adapter;
  }

  /**
   * Get the primary platform adapter from configuration
   * @returns Primary platform adapter
   */
  getDefaultAdapter(): PlatformAdapter {
    const primaryPlatform = this.configService.get<string>(
      'platforms.primary',
      'jira',
    );
    return this.getAdapter(primaryPlatform);
  }

  /**
   * Check if a platform is registered
   * @param platformName Platform identifier
   * @returns true if registered, false otherwise
   */
  isRegistered(platformName: string): boolean {
    return this.adapters.has(platformName);
  }

  /**
   * Get list of all registered platform names
   * @returns Array of platform identifiers
   */
  getAvailablePlatforms(): string[] {
    return Array.from(this.adapters.keys());
  }

  /**
   * Get all registered adapters
   * @returns Map of platform name to adapter instance
   */
  getAllAdapters(): Map<string, PlatformAdapter> {
    return new Map(this.adapters);
  }

  /**
   * Get registered adapters that support pull-request discovery and have
   * explicit credentials configured in wf.config.*.
   *
   * Credentials indicate clear usage intent. Incidental settings such as
   * default repositories or workspaces do not.
   *
   * @returns Map of platform name to adapter instance
   */
  getPullRequestDiscoveryAdapters(): Map<string, PlatformAdapter> {
    return new Map(
      [...this.adapters.entries()].filter(
        ([platformName, adapter]) =>
          typeof adapter.findPullRequestsByTicketKey === 'function' &&
          this.hasPullRequestDiscoveryCredentials(platformName),
      ),
    );
  }

  /**
   * Determine whether a platform has explicit credentials for PR discovery.
   * @param platformName Platform identifier
   * @returns True when the platform has configured auth credentials
   */
  private hasPullRequestDiscoveryCredentials(platformName: string): boolean {
    if (platformName === 'github') {
      return Boolean(this.configService.get<string>('github.token')?.trim());
    }

    if (platformName === 'bitbucket') {
      return Boolean(
        this.configService.get<string>('atlassian.email')?.trim() &&
        this.configService.get<string>('atlassian.bitbucket.apiToken')?.trim(),
      );
    }

    if (platformName === 'jira') {
      return Boolean(
        this.configService.get<string>('atlassian.email')?.trim() &&
        (this.configService.get<string>('atlassian.jira.apiToken')?.trim() ||
          this.configService.get<string>('atlassian.apiToken')?.trim()),
      );
    }

    return false;
  }
}
