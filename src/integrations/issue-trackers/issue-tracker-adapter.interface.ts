import { UniversalTicket, IssueTrackerTicketReference } from '../../common/dto/universal-ticket.dto';

/**
 * Features that a tracker may or may not support
 */
export enum IssueTrackerFeature {
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
 * Options for creating a pull request via IssueTrackerAdapter.createPullRequest
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
 * Base interface that all issue tracker adapters must implement.
 * Enables tracker-agnostic ticket operations.
 */
export interface IssueTrackerAdapter {
  /**
   * Create a new ticket on the tracker
   * @param ticket Universal ticket data
   * @returns Reference to the created ticket
   */
  createTicket(ticket: UniversalTicket): Promise<IssueTrackerTicketReference>;

  /**
   * Get a ticket from the tracker by its reference
   * @param reference Ticket key/ID (e.g., "WBP-2971" for Jira, "123" for GitHub)
   * @returns Universal ticket data
   */
  getTicket(reference: string): Promise<UniversalTicket>;

  /**
   * Update an existing ticket on the tracker
   * @param reference Ticket key/ID
   * @param updates Partial ticket data to update
   */
  updateTicket(reference: string, updates: Partial<UniversalTicket>): Promise<void>;

  /**
   * Check if the tracker supports a specific feature
   * @param feature Feature to check
   * @returns true if supported, false otherwise
   */
  supports(feature: IssueTrackerFeature): boolean;

  /**
   * Get the tracker name (e.g., "jira", "github", "bitbucket")
   * @returns Tracker identifier
   */
  getTrackerName(): string;

  /**
   * Get the diff/changes from a pull request URL
   * Optional - only for trackers that support PRs
   * @param url Pull request URL
   * @returns Diff content as string
   */
  getPullRequestDiff?(url: string): Promise<string>;

  /**
   * Search for tickets on the tracker
   * Optional - only for trackers that support search
   * @param query Tracker-specific query string
   * @returns Array of matching tickets
   */
  searchTickets?(query: string): Promise<UniversalTicket[]>;

  /**
   * Post a comment on a PR or issue
   * Optional — only for trackers that support CREATE_COMMENT
   * @param reference PR URL or issue reference (e.g. "workspace/repo#42")
   * @param body Markdown comment body
   */
  createComment?(reference: string, body: string): Promise<void>;

  /**
   * Post an inline (line-level) comment on a PR diff.
   * Optional — only for trackers that support inline PR comments.
   * @param prUrl Full PR URL
   * @param filePath Diff-relative file path (e.g. "src/foo/bar.ts")
   * @param line Destination-side line number to anchor the comment to
   * @param body Markdown comment body
   */
  createInlineComment?(prUrl: string, filePath: string, line: number, body: string): Promise<void>;

  /**
   * Find an open pull request whose source branch name contains the ticket key
   * Optional — only for trackers that support PR search by branch
   * @param ticketKey Ticket key to search for (e.g. "WBP-2955")
   * @param repoOverride Optional repo in "workspace/repo" format; falls back to default
   * @returns PR URL if found, null otherwise
   */
  findPullRequestByTicketKey?(ticketKey: string, repoOverride?: string): Promise<string | null>;

  /**
   * Find all open pull requests whose source branch or title contains the ticket key.
   * Optional — only for trackers that support PR search by branch/title.
   * @param ticketKey Ticket key to search for (e.g. "WBP-2955")
   * @param repoOverride Optional repo in tracker-specific format; falls back to default
   * @returns Array of matching PR URLs in deterministic order
   */
  findPullRequestsByTicketKey?(ticketKey: string, repoOverride?: string): Promise<string[]>;

  /**
   * Create a pull request on the tracker.
   * Optional — only for trackers that support PR creation.
   *
   * @param options - PR creation parameters
   * @returns URL of the created pull request
   */
  createPullRequest?(options: CreatePullRequestOptions): Promise<string>;
}
