import { Injectable } from '@nestjs/common';

/**
 * Service for managing issue tracker configuration
 *
 * Determines which trackers are enabled based on auto-detection
 * (config presence)
 */
@Injectable()
export class IssueTrackerConfigService {
  constructor() {}

  /**
   * Check if a tracker is enabled
   * Returns true if the tracker has any configuration set (auto-detection)
   *
   * @param _tracker - Tracker name (jira, github, bitbucket)
   * @param hasPartialConfig - Whether the tracker has any configuration set
   * @returns True if tracker is enabled
   */
  isTrackerEnabled(_tracker: 'jira' | 'github' | 'bitbucket', hasPartialConfig: boolean = false): boolean {
    return hasPartialConfig;
  }
}
