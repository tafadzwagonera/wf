import { Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { IssueTrackerAdapter } from './issue-tracker-adapter.interface';

/**
 * Factory service for managing and retrieving issue tracker adapters.
 * Provides centralized access to different tracker implementations.
 */
@Injectable()
export class IssueTrackerService {
  private readonly adapters: Map<string, IssueTrackerAdapter> = new Map();

  constructor(private readonly configService: ConfigService) {}

  /**
   * Register a tracker adapter
   * @param adapter Tracker adapter instance to register
   */
  registerAdapter(adapter: IssueTrackerAdapter): void {
    const trackerName = adapter.getTrackerName();
    this.adapters.set(trackerName, adapter);
  }

  /**
   * Get an adapter for a specific tracker
   * @param trackerName Tracker identifier (e.g., "jira", "github", "bitbucket")
   * @returns Tracker adapter instance
   * @throws NotFoundException if tracker is not registered
   */
  getAdapter(trackerName?: string): IssueTrackerAdapter {
    const tracker = trackerName || this.configService.get<string>('tracker', 'jira');

    const adapter = this.adapters.get(tracker);
    if (!adapter) {
      throw new NotFoundException(
        `Tracker adapter not found for: ${tracker}. Available trackers: ${this.getAvailableTrackers().join(', ')}`
      );
    }

    return adapter;
  }

  /**
   * Get the primary tracker adapter from configuration
   * @returns Primary tracker adapter
   */
  getDefaultAdapter(): IssueTrackerAdapter {
    const primaryTracker = this.configService.get<string>('tracker', 'jira');
    return this.getAdapter(primaryTracker);
  }

  /**
   * Get a list of all registered tracker names
   * @returns Array of tracker identifiers
   */
  getAvailableTrackers(): string[] {
    return Array.from(this.adapters.keys());
  }

  /**
   * Get registered adapters that support pull-request discovery and have
   * explicit credentials configured in wf.config.*.
   *
   * Credentials indicate clear usage intent. Incidental settings such as
   * default repositories or workspaces do not.
   *
   * @returns Map of tracker name to adapter instance
   */
  getPullRequestDiscoveryAdapters(): Map<string, IssueTrackerAdapter> {
    return new Map(
      [...this.adapters.entries()].filter(
        ([trackerName, adapter]) =>
          typeof adapter.findPullRequestsByTicketKey === 'function'
          && this.hasPullRequestDiscoveryCredentials(trackerName)
      )
    );
  }

  /**
   * Determine whether a tracker has explicit credentials for PR discovery.
   * @param trackerName Tracker identifier
   * @returns True when the tracker has configured auth credentials
   */
  private hasPullRequestDiscoveryCredentials(trackerName: string): boolean {
    if (trackerName === 'github') {
      return Boolean(this.configService.get<string>('github.token')?.trim());
    }

    if (trackerName === 'bitbucket') {
      return this.hasAtlassianCredentials('atlassian.bitbucket.apiToken');
    }

    if (trackerName === 'jira') {
      return this.hasAtlassianCredentials('atlassian.jira.apiToken', 'atlassian.apiToken');
    }

    return false;
  }

  /**
   * Check that `atlassian.email` is set and at least one of the given token
   * config keys has a non-empty value.
   * @param tokenKeys One or more config key paths to check for a token value
   * @returns True when email and any supplied token key are both present
   */
  private hasAtlassianCredentials(...tokenKeys: string[]): boolean {
    const hasEmail = Boolean(this.configService.get<string>('atlassian.email')?.trim());
    const hasToken = tokenKeys.some(key => Boolean(this.configService.get<string>(key)?.trim()));
    return hasEmail && hasToken;
  }
}
