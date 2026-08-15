import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Octokit } from '@octokit/rest';
import { IssueTrackerAdapter, IssueTrackerFeature, CreatePullRequestOptions } from '../issue-tracker-adapter.interface';
import { ValidationError } from '../../../shared/utils/errors';
import {
  UniversalTicket,
  IssueTrackerTicketReference,
  TicketType,
  TicketPriority,
} from '../../../common/dto/universal-ticket.dto';
import { LoggerService } from '../../../shared/logger/logger.service';
import { IssueTrackerConfigService } from '../issue-tracker-config.service';

/**
 * Return the name string from a GitHub label, regardless of whether it is a plain string or an object.
 * @param label - A GitHub label value (string or object with a `name` property)
 * @returns The label name string
 */
const getLabelName = (label: string | { name: string }): string =>
  typeof label === 'string' ? label : label.name;

@Injectable()
export class GitHubAdapter implements IssueTrackerAdapter {
  private readonly octokit: Octokit;
  private readonly defaultOwner?: string;
  private readonly defaultRepo?: string;

  constructor(
    private readonly configService: ConfigService,
    private readonly logger: LoggerService,
    private readonly issueTrackerConfig: IssueTrackerConfigService
  ) {
    const token = this.configService.get<string>('github.token');
    const defaultRepo = this.configService.get<string>('github.defaultRepo');
    this.octokit = this.initOctokit(token, Boolean(token || defaultRepo));
    if (defaultRepo) {
      const [owner, repo] = defaultRepo.split('/');
      this.defaultOwner = owner;
      this.defaultRepo = repo;
    }
  }

  /**
   * Initialize the Octokit client, warning when the token is absent.
   * @param token - GitHub personal access token
   * @param hasPartialConfig - Whether any GitHub config key is set
   * @returns Configured Octokit instance
   */
  private initOctokit(token: string | undefined, hasPartialConfig: boolean): Octokit {
    if (!token) {
      if (this.issueTrackerConfig.isTrackerEnabled('github', hasPartialConfig)) {
        this.logger.warn('GitHub token not configured. Set github.token in wf.config.*.');
      }
      return new Octokit();
    }
    return new Octokit({ auth: token });
  }

  async createTicket(ticket: UniversalTicket): Promise<IssueTrackerTicketReference> {
    const { owner, repo } = this.parseProjectOrDefault(ticket.project);
    const response = await this.octokit.issues.create({
      owner, repo,
      title: ticket.title,
      body: ticket.description,
      labels: this.buildLabels(ticket),
      assignees: ticket.assignee ? [ticket.assignee] : undefined,
    });
    const { number, html_url } = response.data;
    return { tracker: 'github', id: number.toString(), key: `${owner}/${repo}#${number}`, url: html_url };
  }

  /**
   * Get an issue from GitHub
   */
  async getTicket(reference: string): Promise<UniversalTicket> {
    const { owner, repo, issueNumber } = this.parseReference(reference);
    const response = await this.octokit.issues.get({ owner, repo, issue_number: issueNumber });
    return this.mapGitHubIssueToUniversal(response.data, owner, repo);
  }

  /**
   * Update an issue on GitHub
   */
  async updateTicket(reference: string, updates: Partial<UniversalTicket>): Promise<void> {
    const { owner, repo, issueNumber } = this.parseReference(reference);
    await this.octokit.issues.update({
      owner,
      repo,
      issue_number: issueNumber,
      ...this.buildGitHubUpdateBody(updates),
    });
  }

  /**
   * Check if GitHub supports a feature
   */
  supports(feature: IssueTrackerFeature): boolean {
    const supportedFeatures = [
      IssueTrackerFeature.CREATE_TICKET,
      IssueTrackerFeature.GET_TICKET,
      IssueTrackerFeature.UPDATE_TICKET,
      IssueTrackerFeature.SEARCH_TICKETS,
      IssueTrackerFeature.GET_PULL_REQUEST,
      IssueTrackerFeature.CREATE_COMMENT,
      IssueTrackerFeature.ADD_LABELS,
      IssueTrackerFeature.ASSIGN_TICKET,
      IssueTrackerFeature.CREATE_PULL_REQUEST,
    ];

    return supportedFeatures.includes(feature);
  }

  /**
   * Get a platform name
   */
  getTrackerName(): string {
    return 'github';
  }

  /**
   * Create a pull request on GitHub
   *
   * @param options - PR creation parameters
   * @returns URL of the created pull request
   */
  async createPullRequest(options: CreatePullRequestOptions): Promise<string> {
    const repoString = options.repo || this.configService.get<string>('github.defaultRepo') || '';

    const { owner, repo } = this.parseProjectOrDefault(repoString || undefined);

    const response = await this.octokit.pulls.create({
      owner,
      repo,
      title: options.title,
      body: options.body,
      head: options.head,
      base: options.base,
    });

    return response.data.html_url;
  }

  /**
   * Get pull request diff from GitHub
   */
  async getPullRequestDiff(url: string): Promise<string> {
    const { owner, repo, prNumber } = this.parsePullRequestUrl(url);

    const response = await this.octokit.pulls.get({
      owner,
      repo,
      pull_number: prNumber,
      mediaType: {
        format: 'diff',
      },
    });

    return response.data as unknown as string;
  }

  /**
   * Post a comment on a GitHub pull request or issue.
   * @param reference PR URL or issue reference
   * @param body Markdown comment body
   */
  async createComment(reference: string, body: string): Promise<void> {
    if (reference.includes('github.com') && reference.includes('/pull/')) {
      const { owner, repo, prNumber } = this.parsePullRequestUrl(reference);
      await this.octokit.issues.createComment({ owner, repo, issue_number: prNumber, body });
      return;
    }
    const { owner, repo, issueNumber } = this.parseReference(reference);
    await this.octokit.issues.createComment({ owner, repo, issue_number: issueNumber, body });
  }

  /**
   * Find open pull requests whose title or branch contains the ticket key.
   * @param ticketKey Ticket key to search for
   * @param repoOverride Optional repo in "owner/repo" format; falls back to default
   * @returns Matching PR URLs sorted by pull request number
   */
  async findPullRequestsByTicketKey(ticketKey: string, repoOverride?: string): Promise<string[]> {
    const { owner, repo } = this.parseProjectOrDefault(repoOverride);
    const response = await this.octokit.search.issuesAndPullRequests({
      q: `repo:${owner}/${repo} is:pr is:open "${ticketKey}"`, per_page: 50,
    });
    const pullRequestUrls = new Set<string>();
    for (const item of response.data.items) {
      if (item.html_url?.includes('/pull/')) pullRequestUrls.add(item.html_url);
    }
    const sortByNumber = (left: string, right: string) =>
      this.extractPullRequestNumber(left) - this.extractPullRequestNumber(right) || left.localeCompare(right);
    return [...pullRequestUrls].sort(sortByNumber);
  }

  /**
   * Search issues on GitHub
   */
  async searchTickets(query: string): Promise<UniversalTicket[]> {
    const response = await this.octokit.search.issuesAndPullRequests({ q: query, per_page: 50 });
    return response.data.items.map(issue => {
      const [owner, repo] = issue.repository_url.split('/').slice(-2);
      return this.mapGitHubIssueToUniversal(issue as any, owner, repo);
    });
  }

  private parseProjectOrDefault(project?: string): { owner: string; repo: string } {
    if (project?.includes('/')) {
      const [owner, repo] = project.split('/');
      return { owner, repo };
    }
    if (this.defaultOwner && this.defaultRepo) return { owner: this.defaultOwner, repo: this.defaultRepo };
    throw new ValidationError(
      'No GitHub repository specified and no default repository configured. '
      + 'Provide project as "owner/repo" or set github.defaultRepo in wf.config.*.'
    );
  }

  private parseReference(reference: string): { owner: string; repo: string; issueNumber: number } {
    if (reference.includes('/') && reference.includes('#')) {
      const [ownerRepo, number] = reference.split('#');
      const [owner, repo] = ownerRepo.split('/');
      return { owner, repo, issueNumber: Number.parseInt(number, 10) };
    }

    if (/^\d+$/.test(reference)) {
      if (!this.defaultOwner || !this.defaultRepo) {
        throw new ValidationError('Cannot use issue number without default repository configured');
      }
      return { owner: this.defaultOwner, repo: this.defaultRepo, issueNumber: Number.parseInt(reference, 10) };
    }

    throw new ValidationError(`Invalid GitHub issue reference: ${reference}`);
  }

  /**
   * Parse pull request URL
   */
  private parsePullRequestUrl(url: string): {
    owner: string;
    repo: string;
    prNumber: number;
  } {
    // Format: https://github.com/owner/repo/pull/123
    const match = new RegExp(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/).exec(url);
    if (!match) {
      throw new ValidationError(`Invalid GitHub PR URL: ${url}`);
    }

    return {
      owner: match[1],
      repo: match[2],
      prNumber: Number.parseInt(match[3], 10),
    };
  }

  private extractPullRequestNumber(url: string): number {
    const match = new RegExp(/\/pull\/(\d+)/).exec(url);
    return match ? Number.parseInt(match[1], 10) : Number.MAX_SAFE_INTEGER;
  }

  /**
   * Map a raw GitHub issue object to a UniversalTicket.
   * @param issue - Raw issue from the Octokit response
   * @param owner - GitHub repository owner
   * @param repo - GitHub repository name
   * @returns Populated UniversalTicket
   */
  private mapGitHubIssueToUniversal(issue: any, owner: string, repo: string): UniversalTicket {
    const project = `${owner}/${repo}`;
    return new UniversalTicket({
      key: `${project}#${issue.number}`, title: issue.title,
      description: issue.body || '',
      type: this.extractTypeFromLabels(issue.labels as any[]), status: issue.state,
      priority: this.extractPriorityFromLabels(issue.labels as any[]),
      assignee: issue.assignee?.login, reporter: issue.user?.login,
      created: new Date(issue.created_at), updated: new Date(issue.updated_at),
      labels: issue.labels.map((l: any) => getLabelName(l)),
      project, trackerData: { githubNumber: issue.number, githubUrl: issue.html_url },
    });
  }

  /**
   * Build a GitHub issues.update body from partial UniversalTicket fields.
   * @param updates - Partial ticket fields to apply
   * @returns Object with only the defined update fields
   */
  private buildGitHubUpdateBody(updates: Partial<UniversalTicket>): Record<string, unknown> {
    const body: Record<string, unknown> = {};
    if (updates.title) body.title = updates.title;
    if (updates.description !== undefined) body.body = updates.description;
    if (updates.status) body.state = updates.status === 'done' ? 'closed' : 'open';
    if (updates.labels) body.labels = updates.labels;
    if (updates.assignee) body.assignees = [updates.assignee];
    return body;
  }

  /**
   * Build a label array including type and priority
   */
  private buildLabels(ticket: UniversalTicket): string[] {
    const labels = [...(ticket.labels || [])];

    if (ticket.type) {
      labels.push(`type:${ticket.type}`);
    }
    if (ticket.priority) {
      labels.push(`priority:${ticket.priority}`);
    }

    return labels;
  }

  private extractTypeFromLabels(labels: any[]): TicketType {
    const typeLabel = labels.find(l => getLabelName(l).startsWith('type:'));
    if (typeLabel) return (getLabelName(typeLabel).replace('type:', '') as TicketType) || TicketType.TASK;

    const hasLabel = (name: string) => labels.some(l => getLabelName(l).toLowerCase() === name.toLowerCase());
    if (hasLabel('bug')) return TicketType.BUG;
    if (hasLabel('enhancement')) return TicketType.STORY;

    return TicketType.TASK;
  }

  private extractPriorityFromLabels(labels: any[]): TicketPriority {
    const priorityLabel = labels.find(l => getLabelName(l).startsWith('priority:'));
    if (priorityLabel) {
      return (getLabelName(priorityLabel).replace('priority:', '') as TicketPriority) || TicketPriority.MEDIUM;
    }
    return TicketPriority.MEDIUM;
  }
}
