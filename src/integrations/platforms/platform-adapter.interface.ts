import {
  UniversalTicket,
  PlatformTicketReference,
} from '../../common/dto/universal-ticket.dto';

/**
 * Features that a platform may or may not support
 */
export enum PlatformFeature {
  CREATE_TICKET = 'create_ticket',
  GET_TICKET = 'get_ticket',
  UPDATE_TICKET = 'update_ticket',
  DELETE_TICKET = 'delete_ticket',
  SEARCH_TICKETS = 'search_tickets',
  GET_PULL_REQUEST = 'get_pull_request',
  CREATE_COMMENT = 'create_comment',
  ASSIGN_TICKET = 'assign_ticket',
  ADD_LABELS = 'add_labels',
  CREATE_INLINE_COMMENT = 'create_inline_comment',
  CREATE_PULL_REQUEST = 'create_pull_request',
}

/**
 * Options for creating a pull request via PlatformAdapter.createPullRequest
 */
export interface CreatePullRequestOptions {
  /** PR title */
  title: string;
  /** PR body (markdown) */
  body: string;
  /** Source branch name */
  head: string;
  /** Target branch name (e.g. 'main') */
  base: string;
  /**
   * Repository in "owner/repo" format.
   * Falls back to GITHUB_DEFAULT_REPO if omitted.
   */
  repo?: string;
}

/**
 * Base interface that all platform adapters must implement.
 * Enables platform-agnostic ticket operations.
 */
export interface PlatformAdapter {
  /**
   * Create a new ticket on the platform
   * @param ticket Universal ticket data
   * @returns Reference to the created ticket
   */
  createTicket(ticket: UniversalTicket): Promise<PlatformTicketReference>;

  /**
   * Get a ticket from the platform by its reference
   * @param reference Ticket key/ID (e.g., "WBP-2971" for Jira, "123" for GitHub)
   * @returns Universal ticket data
   */
  getTicket(reference: string): Promise<UniversalTicket>;

  /**
   * Update an existing ticket on the platform
   * @param reference Ticket key/ID
   * @param updates Partial ticket data to update
   */
  updateTicket(
    reference: string,
    updates: Partial<UniversalTicket>,
  ): Promise<void>;

  /**
   * Check if the platform supports a specific feature
   * @param feature Feature to check
   * @returns true if supported, false otherwise
   */
  supports(feature: PlatformFeature): boolean;

  /**
   * Get the platform name (e.g., "jira", "github", "bitbucket")
   * @returns Platform identifier
   */
  getPlatformName(): string;

  /**
   * Get the diff/changes from a pull request URL
   * Optional - only for platforms that support PRs
   * @param url Pull request URL
   * @returns Diff content as string
   */
  getPullRequestDiff?(url: string): Promise<string>;

  /**
   * Search for tickets on the platform
   * Optional - only for platforms that support search
   * @param query Platform-specific query string
   * @returns Array of matching tickets
   */
  searchTickets?(query: string): Promise<UniversalTicket[]>;

  /**
   * Post a comment on a PR or issue
   * Optional — only for platforms that support CREATE_COMMENT
   * @param reference PR URL or issue reference (e.g. "workspace/repo#42")
   * @param body Markdown comment body
   */
  createComment?(reference: string, body: string): Promise<void>;

  /**
   * Post an inline (line-level) comment on a PR diff.
   * Optional — only for platforms that support inline PR comments.
   * @param prUrl Full PR URL
   * @param filePath Diff-relative file path (e.g. "src/foo/bar.ts")
   * @param line Destination-side line number to anchor the comment to
   * @param body Markdown comment body
   */
  createInlineComment?(
    prUrl: string,
    filePath: string,
    line: number,
    body: string,
  ): Promise<void>;

  /**
   * Find an open pull request whose source branch name contains the ticket key
   * Optional — only for platforms that support PR search by branch
   * @param ticketKey Ticket key to search for (e.g. "WBP-2955")
   * @param repoOverride Optional repo in "workspace/repo" format; falls back to default
   * @returns PR URL if found, null otherwise
   */
  findPullRequestByTicketKey?(
    ticketKey: string,
    repoOverride?: string,
  ): Promise<string | null>;

  /**
   * Create a pull request on the platform.
   * Optional — only for platforms that support PR creation.
   *
   * @param options - PR creation parameters
   * @returns URL of the created pull request
   */
  createPullRequest?(options: CreatePullRequestOptions): Promise<string>;
}
