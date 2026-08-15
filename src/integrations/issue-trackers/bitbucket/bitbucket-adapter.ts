import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Bitbucket } from 'bitbucket';
import { IssueTrackerAdapter, IssueTrackerFeature } from '../issue-tracker-adapter.interface';
import { ValidationError } from '../../../shared/utils/errors';
import {
  UniversalTicket,
  IssueTrackerTicketReference,
  TicketType,
  TicketPriority,
} from '../../../common/dto/universal-ticket.dto';
import { LoggerService } from '../../../shared/logger/logger.service';
import { IssueTrackerConfigService } from '../issue-tracker-config.service';

@Injectable()
export class BitBucketAdapter implements IssueTrackerAdapter {
  private readonly bitbucket: InstanceType<typeof Bitbucket>;
  private readonly defaultWorkspace?: string;

  constructor(
    private readonly configService: ConfigService,
    private readonly logger: LoggerService,
    private readonly issueTrackerConfig: IssueTrackerConfigService
  ) {
    const email = this.configService.get<string>('atlassian.email');
    const apiToken = this.configService.get<string>('atlassian.bitbucket.apiToken');
    const workspace = this.configService.get<string>('atlassian.bitbucket.workspace');
    this.bitbucket = this.initBitbucketClient(email, apiToken, Boolean(apiToken || workspace));
    if (workspace) this.defaultWorkspace = workspace;
  }

  /**
   * Initialise the Bitbucket SDK client, warning when credentials are absent.
   * @param email - Atlassian account e-mail
   * @param apiToken - Bitbucket API token
   * @param hasPartialConfig - Whether any Bitbucket config key is set
   * @returns Configured Bitbucket client instance
   */
  private initBitbucketClient(
    email: string | undefined,
    apiToken: string | undefined,
    hasPartialConfig: boolean
  ): InstanceType<typeof Bitbucket> {
    if (!email || !apiToken) {
      if (this.issueTrackerConfig.isTrackerEnabled('bitbucket', hasPartialConfig)) {
        this.logger.warn(
          'BitBucket credentials not configured. Set atlassian.email, atlassian.bitbucket.apiToken, and atlassian.bitbucket.workspace in wf.config.*.'
        );
      }
      return new Bitbucket();
    }
    return new Bitbucket({ auth: { username: email, password: apiToken } });
  }

  /**
   * Create an issue on BitBucket
   */
  async createTicket(ticket: UniversalTicket): Promise<IssueTrackerTicketReference> {
    const { workspace, repo } = this.parseProjectOrDefault(ticket.project);
    const response = await this.bitbucket.issue.create({
      workspace,
      repo_slug: repo,
      _body: this.buildBitbucketCreateBody(ticket),
    });
    const issue = response.data;
    return {
      tracker: 'bitbucket',
      id: issue.id.toString(),
      key: `${workspace}/${repo}#${issue.id}`,
      url: issue.links?.html?.href,
    };
  }

  /**
   * Get an issue from BitBucket
   */
  async getTicket(reference: string): Promise<UniversalTicket> {
    const { workspace, repo, issueId } = this.parseReference(reference);
    const response = await this.bitbucket.issue.get({ workspace, repo_slug: repo, issue_id: issueId });
    return this.mapBitbucketIssueToUniversal(response.data, workspace, repo);
  }

  /**
   * Update an issue on BitBucket
   */
  async updateTicket(reference: string, updates: Partial<UniversalTicket>): Promise<void> {
    const { workspace, repo, issueId } = this.parseReference(reference);
    await this.bitbucket.issue.update({
      workspace,
      repo_slug: repo,
      issue_id: issueId,
      _body: this.buildBitbucketUpdateBody(updates),
    });
  }

  /**
   * Check if BitBucket supports a feature
   */
  supports(feature: IssueTrackerFeature): boolean {
    const supportedFeatures = [
      IssueTrackerFeature.CREATE_TICKET,
      IssueTrackerFeature.GET_TICKET,
      IssueTrackerFeature.UPDATE_TICKET,
      IssueTrackerFeature.SEARCH_TICKETS,
      IssueTrackerFeature.GET_PULL_REQUEST,
      IssueTrackerFeature.CREATE_COMMENT,
      IssueTrackerFeature.CREATE_INLINE_COMMENT,
    ];

    return supportedFeatures.includes(feature);
  }

  /**
   * Get platform name
   */
  getTrackerName(): string {
    return 'bitbucket';
  }

  /**
   * Post a comment on a BitBucket PR or issue
   * @param reference PR URL (https://bitbucket.org/…/pull-requests/123) or issue reference (workspace/repo#42 or 42)
   * @param body Markdown comment body
   */
  async createComment(reference: string, body: string): Promise<void> {
    if (reference.includes('bitbucket.org') && reference.includes('pull-requests')) {
      const { workspace, repo, prId } = this.parsePullRequestUrl(reference);
      await this.bitbucket.pullrequests.createComment({
        workspace, repo_slug: repo, pull_request_id: prId,
        _body: { content: { raw: body } } as any,
      });
      return;
    }
    const { workspace, repo, issueId } = this.parseReference(reference);
    await this.bitbucket.issue.createComment({
      workspace, repo_slug: repo, issue_id: issueId,
      _body: { content: { raw: body } },
    });
  }

  /**
   * Post an inline (line-level) comment on a BitBucket PR diff.
   * @param prUrl Full PR URL
   * @param filePath Diff-relative file path (e.g. "src/foo/bar.ts")
   * @param line Destination-side line number to anchor the comment to
   * @param body Markdown comment body
   */
  async createInlineComment(prUrl: string, filePath: string, line: number, body: string): Promise<void> {
    const { workspace, repo, prId } = this.parsePullRequestUrl(prUrl);
    await this.bitbucket.pullrequests.createComment({
      workspace,
      repo_slug: repo,
      pull_request_id: prId,
      _body: {
        content: { raw: body },
        inline: { path: filePath, to: line },
      } as any,
    });
  }

  /**
   * Find an open pull request whose source branch name contains the ticket key
   * @param ticketKey Ticket key to search for (e.g. "WBP-2955")
   * @param repoOverride Optional repo in "workspace/repo" format; falls back to default
   * @returns PR URL if found, null otherwise
   */
  async findPullRequestByTicketKey(ticketKey: string, repoOverride?: string): Promise<string | null> {
    const matches = await this.findPullRequestsByTicketKey(ticketKey, repoOverride);

    return matches[0] ?? null;
  }

  /**
   * Find open pull requests whose source branch or title contains the ticket key.
   * @param ticketKey Ticket key to search for (e.g. "WBP-2955")
   * @param repoOverride Optional repo in "workspace/repo" format; falls back to default
   * @returns Matching PR URLs sorted by pull request id
   */
  async findPullRequestsByTicketKey(ticketKey: string, repoOverride?: string): Promise<string[]> {
    const { workspace, repo } = this.parseProjectOrDefault(repoOverride);
    const pullRequestUrls = new Set<string>();
    const listArgs = (q: string) => ({ workspace, repo_slug: repo, q });

    const byBranch = await this.bitbucket.pullrequests.list(
      listArgs(`source.branch.name ~ "${ticketKey}" AND state = "OPEN"`)
    );
    this.collectPullRequestUrls(byBranch.data.values, pullRequestUrls);

    const byTitle = await this.bitbucket.pullrequests.list(listArgs(`title ~ "${ticketKey}" AND state = "OPEN"`));
    this.collectPullRequestUrls(byTitle.data.values, pullRequestUrls);

    const sortById = (left: string, right: string) =>
      this.extractPullRequestId(left) - this.extractPullRequestId(right) || left.localeCompare(right);
    return [...pullRequestUrls].sort(sortById);
  }

  /**
   * Get pull request diff from BitBucket
   */
  async getPullRequestDiff(url: string): Promise<string> {
    const { workspace, repo, prId } = this.parsePullRequestUrl(url);

    const response = await this.bitbucket.pullrequests.getDiff({
      workspace,
      repo_slug: repo,
      pull_request_id: prId,
    });

    return response.data as unknown as string;
  }

  /**
   * Build the Bitbucket issue create request body from a universal ticket.
   * @param ticket - Universal ticket to convert
   * @returns Bitbucket create body object
   */
  private buildBitbucketCreateBody(ticket: UniversalTicket): Record<string, unknown> {
    return {
      title: ticket.title,
      content: { raw: ticket.description },
      kind: this.mapTicketTypeToBitBucket(ticket.type),
      priority: this.mapPriorityToBitBucket(ticket.priority),
    };
  }

  /**
   * Map a raw Bitbucket issue to a UniversalTicket.
   * @param issue - Raw issue object from Bitbucket API
   * @param workspace - Bitbucket workspace slug
   * @param repo - Bitbucket repository slug
   * @returns Populated UniversalTicket
   */
  private mapBitbucketIssueToUniversal(issue: any, workspace: string, repo: string): UniversalTicket {
    const project = `${workspace}/${repo}`;
    return new UniversalTicket({
      key: `${project}#${issue.id}`, title: issue.title,
      description: issue.content?.raw || '',
      type: this.mapBitBucketTypeToUniversal(issue.kind), status: issue.state,
      priority: this.mapBitBucketPriorityToUniversal(issue.priority),
      assignee: issue.assignee?.display_name, reporter: issue.reporter?.display_name,
      created: new Date(issue.created_on), updated: new Date(issue.updated_on),
      project, trackerData: { bitbucketId: issue.id, bitbucketUrl: issue.links?.html?.href },
    });
  }

  /**
   * Build the Bitbucket issue update body from partial universal ticket fields.
   * @param updates - Partial fields to apply
   * @returns Bitbucket update body object
   */
  private buildBitbucketUpdateBody(updates: Partial<UniversalTicket>): Record<string, unknown> {
    const body: Record<string, unknown> = {};
    if (updates.title) body.title = updates.title;
    if (updates.description !== undefined) body.content = { raw: updates.description };
    if (updates.status) body.state = updates.status;
    if (updates.type) body.kind = this.mapTicketTypeToBitBucket(updates.type);
    if (updates.priority) body.priority = this.mapPriorityToBitBucket(updates.priority);
    return body;
  }

  /**
   * Collect PR URLs from a Bitbucket response page into the given Set.
   * @param values - Array of pull request objects from the Bitbucket API
   * @param into - Set to accumulate discovered URLs into
   */
  private collectPullRequestUrls(values: any[] | undefined, into: Set<string>): void {
    for (const pullRequest of values ?? []) {
      const url = pullRequest.links?.html?.href;
      if (url) into.add(url);
    }
  }

  private extractPullRequestId(url: string): number {
    const match = new RegExp(/pull-requests\/(\d+)/).exec(url);
    return match ? Number.parseInt(match[1], 10) : Number.MAX_SAFE_INTEGER;
  }

  /**
   * Search issues on BitBucket
   */
  async searchTickets(query: string): Promise<UniversalTicket[]> {
    const { workspace, repo } = this.parseProjectOrDefault();
    const response = await this.bitbucket.issue.list({ workspace, repo_slug: repo, q: query });
    const issues = response.data.values || [];
    return issues.map((issue: any) => this.mapBitbucketIssueToUniversal(issue, workspace, repo));
  }

  private parseProjectOrDefault(project?: string): { workspace: string; repo: string } {
    const p = project?.trim();
    if (p?.includes('/')) {
      const [workspace, repo] = p.split('/');
      return { workspace, repo };
    }
    if (p && this.defaultWorkspace) return { workspace: this.defaultWorkspace, repo: p };
    throw new ValidationError(
      'No BitBucket repository specified. Provide the repository as "workspace/repo" or pass --repos <repo> so the configured workspace can be used.'
    );
  }

  /**
   * Parse issue reference (supports: "workspace/repo#123")
   */
  private parseReference(reference: string): {
    workspace: string;
    repo: string;
    issueId: number;
  } {
    // Format: workspace/repo#123
    if (reference.includes('/') && reference.includes('#')) {
      const [workspaceRepo, id] = reference.split('#');
      const [workspace, repo] = workspaceRepo.split('/');
      return { workspace, repo, issueId: Number.parseInt(id, 10) };
    }

    throw new ValidationError(`Invalid BitBucket issue reference: "${reference}". Expected format: workspace/repo#123`);
  }

  /**
   * Parse pull request URL
   */
  private parsePullRequestUrl(url: string): {
    workspace: string;
    repo: string;
    prId: number;
  } {
    // Format: https://bitbucket.org/workspace/repo/pull-requests/123
    const match = new RegExp(/bitbucket\.org\/([^/]+)\/([^/]+)\/pull-requests\/(\d+)/).exec(url);
    if (!match) {
      throw new ValidationError(`Invalid BitBucket PR URL: ${url}`);
    }

    return {
      workspace: match[1],
      repo: match[2],
      prId: Number.parseInt(match[3], 10),
    };
  }

  /**
   * Map UniversalTicket type to BitBucket kind
   */
  private mapTicketTypeToBitBucket(type?: TicketType): string {
    if (!type) return 'task';

    const typeMap: Record<string, string> = {
      [TicketType.TASK]: 'task',
      [TicketType.BUG]: 'bug',
      [TicketType.STORY]: 'enhancement',
      [TicketType.TODO]: 'task',
      [TicketType.EPIC]: 'proposal',
      [TicketType.SUBTASK]: 'task',
    };

    return typeMap[type] || 'task';
  }

  /**
   * Map BitBucket kind to UniversalTicket type
   */
  private mapBitBucketTypeToUniversal(bitbucketKind: string): TicketType {
    const typeMap: Record<string, TicketType> = {
      task: TicketType.TASK,
      bug: TicketType.BUG,
      enhancement: TicketType.STORY,
      proposal: TicketType.EPIC,
    };

    return typeMap[bitbucketKind] || TicketType.TASK;
  }

  /**
   * Map the normalized wf priority vocabulary to Bitbucket's fixed priority
   * labels.
   */
  private mapPriorityToBitBucket(priority?: TicketPriority): string {
    if (!priority) return 'major';

    const priorityMap: Record<string, string> = {
      [TicketPriority.HIGHEST]: 'critical',
      [TicketPriority.HIGH]: 'major',
      [TicketPriority.MEDIUM]: 'minor',
      [TicketPriority.LOW]: 'trivial',
      [TicketPriority.LOWEST]: 'trivial',
    };

    return priorityMap[priority] || 'major';
  }

  /**
   * Map Bitbucket's priority labels back into the normalized wf vocabulary.
   */
  private mapBitBucketPriorityToUniversal(bitbucketPriority: string): TicketPriority {
    const priorityMap: Record<string, TicketPriority> = {
      critical: TicketPriority.HIGHEST,
      major: TicketPriority.HIGH,
      minor: TicketPriority.MEDIUM,
      trivial: TicketPriority.LOW,
      blocker: TicketPriority.HIGHEST,
    };

    return priorityMap[bitbucketPriority] || TicketPriority.MEDIUM;
  }
}
