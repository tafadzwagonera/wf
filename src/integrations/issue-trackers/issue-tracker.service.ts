import { Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { IssueTrackerAdapter } from './issue-tracker-adapter.interface';

/**
 * Factory service for managing and retrieving issue tracker adapters.
 * Provides centralized access to different tracker implementations.
 */
@Injectable()
export class IssueTrackerService {
  private adapters: Map<string, IssueTrackerAdapter> = new Map();

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
   * Check if a tracker is registered
   * @param trackerName Tracker identifier
   * @returns true if registered, false otherwise
   */
  isRegistered(trackerName: string): boolean {
    return this.adapters.has(trackerName);
  }

  /**
   * Get list of all registered tracker names
   * @returns Array of tracker identifiers
   */
  getAvailableTrackers(): string[] {
    return Array.from(this.adapters.keys());
  }

  /**
   * Get all registered adapters
   * @returns Map of tracker name to adapter instance
   */
  getAllAdapters(): Map<string, IssueTrackerAdapter> {
    return new Map(this.adapters);
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
      return Boolean(
        this.configService.get<string>('atlassian.email')?.trim()
        && this.configService.get<string>('atlassian.bitbucket.apiToken')?.trim()
      );
    }

    if (trackerName === 'jira') {
      return Boolean(
        this.configService.get<string>('atlassian.email')?.trim()
        && (this.configService.get<string>('atlassian.jira.apiToken')?.trim()
          || this.configService.get<string>('atlassian.apiToken')?.trim())
      );
    }

    return false;
  }
}
