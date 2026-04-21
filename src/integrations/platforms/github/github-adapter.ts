import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Octokit } from '@octokit/rest';
import {
  PlatformAdapter,
  PlatformFeature,
  CreatePullRequestOptions,
} from '../platform-adapter.interface';
import {
  UniversalTicket,
  PlatformTicketReference,
  TicketType,
  TicketPriority,
} from '../../../common/dto/universal-ticket.dto';
import { LoggerService } from '../../../shared/logger/logger.service';
import { PlatformConfigService } from '../platform-config.service';

/**
 * GitHub platform adapter implementing PlatformAdapter interface
 * Handles GitHub issues and pull requests
 */
@Injectable()
export class GitHubAdapter implements PlatformAdapter {
  private octokit: Octokit;
  private defaultOwner?: string;
  private defaultRepo?: string;

  constructor(
    private readonly configService: ConfigService,
    private readonly logger: LoggerService,
    private readonly platformConfig: PlatformConfigService,
  ) {
    const token = this.configService.get<string>('github.token');
    const defaultRepo = this.configService.get<string>('github.defaultRepo');

    // Check if platform has any configuration (partial config detection)
    const hasPartialConfig = Boolean(token || defaultRepo);

    if (!token) {
      // Only warn if platform is enabled
      if (this.platformConfig.isPlatformEnabled('github', hasPartialConfig)) {
        this.logger.warn(
          'GitHub token not configured. Set github.token in wf.config.*.',
        );
      }
      this.octokit = new Octokit();
    } else {
      this.octokit = new Octokit({ auth: token });
    }

    // Parse default repo from config if provided (format: owner/repo)
    if (defaultRepo) {
      const [owner, repo] = defaultRepo.split('/');
      this.defaultOwner = owner;
      this.defaultRepo = repo;
    }
  }

  /**
   * Create an issue on GitHub
   */
  async createTicket(
    ticket: UniversalTicket,
  ): Promise<PlatformTicketReference> {
    const { owner, repo } = this.parseProjectOrDefault(ticket.project);

    const labels = this.buildLabels(ticket);

    const response = await this.octokit.issues.create({
      owner,
      repo,
      title: ticket.title,
      body: ticket.description,
      labels,
      assignees: ticket.assignee ? [ticket.assignee] : undefined,
    });

    return {
      platform: 'github',
      id: response.data.number.toString(),
      key: `${owner}/${repo}#${response.data.number}`,
      url: response.data.html_url,
    };
  }

  /**
   * Get an issue from GitHub
   */
  async getTicket(reference: string): Promise<UniversalTicket> {
    const { owner, repo, issueNumber } = this.parseReference(reference);

    const response = await this.octokit.issues.get({
      owner,
      repo,
      issue_number: issueNumber,
    });

    const issue = response.data;

    return new UniversalTicket({
      key: `${owner}/${repo}#${issue.number}`,
      title: issue.title,
      description: issue.body || '',
      type: this.extractTypeFromLabels(issue.labels as any[]),
      status: issue.state,
      priority: this.extractPriorityFromLabels(issue.labels as any[]),
      assignee: issue.assignee?.login,
      reporter: issue.user?.login,
      created: new Date(issue.created_at),
      updated: new Date(issue.updated_at),
      labels: issue.labels.map((l: any) =>
        typeof l === 'string' ? l : l.name,
      ),
      project: `${owner}/${repo}`,
      platformData: {
        githubNumber: issue.number,
        githubUrl: issue.html_url,
      },
    });
  }

  /**
   * Update an issue on GitHub
   */
  async updateTicket(
    reference: string,
    updates: Partial<UniversalTicket>,
  ): Promise<void> {
    const { owner, repo, issueNumber } = this.parseReference(reference);

    const updateData: any = {};

    if (updates.title) {
      updateData.title = updates.title;
    }
    if (updates.description !== undefined) {
      updateData.body = updates.description;
    }
    if (updates.status) {
      updateData.state = updates.status === 'done' ? 'closed' : 'open';
    }
    if (updates.labels) {
      updateData.labels = updates.labels;
    }
    if (updates.assignee) {
      updateData.assignees = [updates.assignee];
    }

    await this.octokit.issues.update({
      owner,
      repo,
      issue_number: issueNumber,
      ...updateData,
    });
  }

  /**
   * Check if GitHub supports a feature
   */
  supports(feature: PlatformFeature): boolean {
    const supportedFeatures = [
      PlatformFeature.CREATE_TICKET,
      PlatformFeature.GET_TICKET,
      PlatformFeature.UPDATE_TICKET,
      PlatformFeature.SEARCH_TICKETS,
      PlatformFeature.GET_PULL_REQUEST,
      PlatformFeature.CREATE_COMMENT,
      PlatformFeature.ADD_LABELS,
      PlatformFeature.ASSIGN_TICKET,
      PlatformFeature.CREATE_PULL_REQUEST,
    ];

    return supportedFeatures.includes(feature);
  }

  /**
   * Get platform name
   */
  getPlatformName(): string {
    return 'github';
  }

  /**
   * Create a pull request on GitHub
   *
   * @param options - PR creation parameters
   * @returns URL of the created pull request
   */
  async createPullRequest(options: CreatePullRequestOptions): Promise<string> {
    const repoString =
      options.repo ||
      this.configService.get<string>('github.defaultRepo') ||
      '';

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
      await this.octokit.issues.createComment({
        owner,
        repo,
        issue_number: prNumber,
        body,
      });
      return;
    }

    const { owner, repo, issueNumber } = this.parseReference(reference);
    await this.octokit.issues.createComment({
      owner,
      repo,
      issue_number: issueNumber,
      body,
    });
  }

  /**
   * Find open pull requests whose title or branch contains the ticket key.
   * @param ticketKey Ticket key to search for
   * @param repoOverride Optional repo in "owner/repo" format; falls back to default
   * @returns Matching PR URLs sorted by pull request number
   */
  async findPullRequestsByTicketKey(
    ticketKey: string,
    repoOverride?: string,
  ): Promise<string[]> {
    const { owner, repo } = this.parseProjectOrDefault(repoOverride);
    const query = `repo:${owner}/${repo} is:pr is:open "${ticketKey}"`;
    const response = await this.octokit.search.issuesAndPullRequests({
      q: query,
      per_page: 50,
    });

    const pullRequestUrls = new Set<string>();
    response.data.items.forEach((item) => {
      if (!item.html_url?.includes('/pull/')) {
        return;
      }

      pullRequestUrls.add(item.html_url);
    });

    return [...pullRequestUrls].sort((left, right) => {
      const leftNumber = this.extractPullRequestNumber(left);
      const rightNumber = this.extractPullRequestNumber(right);
      return leftNumber - rightNumber || left.localeCompare(right);
    });
  }

  /**
   * Search issues on GitHub
   */
  async searchTickets(query: string): Promise<UniversalTicket[]> {
    const response = await this.octokit.search.issuesAndPullRequests({
      q: query,
      per_page: 50,
    });

    return response.data.items.map(
      (issue) =>
        new UniversalTicket({
          key: `${issue.repository_url.split('/').slice(-2).join('/')}#${issue.number}`,
          title: issue.title,
          description: issue.body || '',
          type: this.extractTypeFromLabels(issue.labels as any[]),
          status: issue.state,
          priority: this.extractPriorityFromLabels(issue.labels as any[]),
          assignee: issue.assignee?.login,
          reporter: issue.user?.login,
          created: new Date(issue.created_at),
          updated: new Date(issue.updated_at),
          labels: issue.labels.map((l: any) =>
            typeof l === 'string' ? l : l.name,
          ),
          platformData: {
            githubNumber: issue.number,
            githubUrl: issue.html_url,
          },
        }),
    );
  }

  /**
   * Parse project string or use default
   */
  private parseProjectOrDefault(project?: string): {
    owner: string;
    repo: string;
  } {
    if (project && project.includes('/')) {
      const [owner, repo] = project.split('/');
      return { owner, repo };
    }

    if (this.defaultOwner && this.defaultRepo) {
      return { owner: this.defaultOwner, repo: this.defaultRepo };
    }

    throw new Error(
      'No GitHub repository specified and no default repository configured. ' +
        'Provide project as "owner/repo" or set github.defaultRepo in wf.config.*.',
    );
  }

  /**
   * Parse issue reference (supports: "owner/repo#123" or just "123")
   */
  private parseReference(reference: string): {
    owner: string;
    repo: string;
    issueNumber: number;
  } {
    // Format: owner/repo#123
    if (reference.includes('/') && reference.includes('#')) {
      const [ownerRepo, number] = reference.split('#');
      const [owner, repo] = ownerRepo.split('/');
      return { owner, repo, issueNumber: parseInt(number, 10) };
    }

    // Format: 123 (use default repo)
    if (/^\d+$/.test(reference)) {
      if (!this.defaultOwner || !this.defaultRepo) {
        throw new Error(
          'Cannot use issue number without default repository configured',
        );
      }
      return {
        owner: this.defaultOwner,
        repo: this.defaultRepo,
        issueNumber: parseInt(reference, 10),
      };
    }

    throw new Error(`Invalid GitHub issue reference: ${reference}`);
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
    const match = url.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
    if (!match) {
      throw new Error(`Invalid GitHub PR URL: ${url}`);
    }

    return {
      owner: match[1],
      repo: match[2],
      prNumber: parseInt(match[3], 10),
    };
  }

  private extractPullRequestNumber(url: string): number {
    const match = url.match(/\/pull\/(\d+)/);
    return match ? parseInt(match[1], 10) : Number.MAX_SAFE_INTEGER;
  }

  /**
   * Build labels array including type and priority
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

  /**
   * Extract ticket type from GitHub labels
   */
  private extractTypeFromLabels(labels: any[]): TicketType {
    const typeLabel = labels.find((l) => {
      const name = typeof l === 'string' ? l : l.name;
      return name.startsWith('type:');
    });

    if (typeLabel) {
      const name = typeof typeLabel === 'string' ? typeLabel : typeLabel.name;
      const type = name.replace('type:', '');
      return (type as TicketType) || TicketType.TASK;
    }

    // Check for standard GitHub labels
    const hasLabel = (name: string) =>
      labels.some((l) => {
        const labelName = typeof l === 'string' ? l : l.name;
        return labelName.toLowerCase() === name.toLowerCase();
      });

    if (hasLabel('bug')) return TicketType.BUG;
    if (hasLabel('enhancement')) return TicketType.STORY;

    return TicketType.TASK;
  }

  /**
   * Extract the normalized wf priority from GitHub labels.
   *
   * GitHub does not have a native issue priority field, so the adapter
   * encodes and decodes priority through labels.
   */
  private extractPriorityFromLabels(labels: any[]): TicketPriority {
    const priorityLabel = labels.find((l) => {
      const name = typeof l === 'string' ? l : l.name;
      return name.startsWith('priority:');
    });

    if (priorityLabel) {
      const name =
        typeof priorityLabel === 'string' ? priorityLabel : priorityLabel.name;
      const priority = name.replace('priority:', '');
      return (priority as TicketPriority) || TicketPriority.MEDIUM;
    }

    return TicketPriority.MEDIUM;
  }
}
