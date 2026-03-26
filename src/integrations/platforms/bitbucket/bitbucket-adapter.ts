import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Bitbucket } from 'bitbucket';
import {
  PlatformAdapter,
  PlatformFeature,
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
 * BitBucket platform adapter implementing PlatformAdapter interface
 * Handles BitBucket issues and pull requests
 */
@Injectable()
export class BitBucketAdapter implements PlatformAdapter {
  private bitbucket: InstanceType<typeof Bitbucket>;
  private defaultWorkspace?: string;

  constructor(
    private readonly configService: ConfigService,
    private readonly logger: LoggerService,
    private readonly platformConfig: PlatformConfigService,
  ) {
    const email = this.configService.get<string>('atlassian.email');
    const apiToken = this.configService.get<string>(
      'atlassian.bitbucket.apiToken',
    );
    const workspace = this.configService.get<string>(
      'atlassian.bitbucket.workspace',
    );

    // Check if platform has any configuration (partial config detection)
    const hasPartialConfig = Boolean(apiToken || workspace);

    if (!email || !apiToken) {
      // Only warn if platform is enabled
      if (
        this.platformConfig.isPlatformEnabled('bitbucket', hasPartialConfig)
      ) {
        this.logger.warn(
          'BitBucket credentials not configured. Set ATLASSIAN_EMAIL, ATLASSIAN_BITBUCKET_API_TOKEN and ATLASSIAN_BITBUCKET_WORKSPACE in .env',
        );
      }
      this.bitbucket = new Bitbucket();
    } else {
      this.bitbucket = new Bitbucket({
        auth: { username: email, password: apiToken },
      });
    }

    if (workspace) {
      this.defaultWorkspace = workspace;
    }
  }

  /**
   * Create an issue on BitBucket
   */
  async createTicket(
    ticket: UniversalTicket,
  ): Promise<PlatformTicketReference> {
    const { workspace, repo } = this.parseProjectOrDefault(ticket.project);

    const response = await this.bitbucket.issue.create({
      workspace,
      repo_slug: repo,
      _body: {
        title: ticket.title,
        content: {
          raw: ticket.description,
        },
        kind: this.mapTicketTypeToBitBucket(ticket.type),
        priority: this.mapPriorityToBitBucket(ticket.priority),
      },
    });

    const issue = response.data;

    return {
      platform: 'bitbucket',
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

    const response = await this.bitbucket.issue.get({
      workspace,
      repo_slug: repo,
      issue_id: issueId,
    });

    const issue = response.data;

    return new UniversalTicket({
      key: `${workspace}/${repo}#${issue.id}`,
      title: issue.title,
      description: issue.content?.raw || '',
      type: this.mapBitBucketTypeToUniversal(issue.kind),
      status: issue.state,
      priority: this.mapBitBucketPriorityToUniversal(issue.priority),
      assignee: issue.assignee?.display_name,
      reporter: issue.reporter?.display_name,
      created: new Date(issue.created_on),
      updated: new Date(issue.updated_on),
      project: `${workspace}/${repo}`,
      platformData: {
        bitbucketId: issue.id,
        bitbucketUrl: issue.links?.html?.href,
      },
    });
  }

  /**
   * Update an issue on BitBucket
   */
  async updateTicket(
    reference: string,
    updates: Partial<UniversalTicket>,
  ): Promise<void> {
    const { workspace, repo, issueId } = this.parseReference(reference);

    const updateData: any = {};

    if (updates.title) {
      updateData.title = updates.title;
    }
    if (updates.description !== undefined) {
      updateData.content = { raw: updates.description };
    }
    if (updates.status) {
      updateData.state = updates.status;
    }
    if (updates.type) {
      updateData.kind = this.mapTicketTypeToBitBucket(updates.type);
    }
    if (updates.priority) {
      updateData.priority = this.mapPriorityToBitBucket(updates.priority);
    }

    await this.bitbucket.issue.update({
      workspace,
      repo_slug: repo,
      issue_id: issueId,
      _body: updateData,
    });
  }

  /**
   * Check if BitBucket supports a feature
   */
  supports(feature: PlatformFeature): boolean {
    const supportedFeatures = [
      PlatformFeature.CREATE_TICKET,
      PlatformFeature.GET_TICKET,
      PlatformFeature.UPDATE_TICKET,
      PlatformFeature.SEARCH_TICKETS,
      PlatformFeature.GET_PULL_REQUEST,
      PlatformFeature.CREATE_COMMENT,
      PlatformFeature.CREATE_INLINE_COMMENT,
    ];

    return supportedFeatures.includes(feature);
  }

  /**
   * Get platform name
   */
  getPlatformName(): string {
    return 'bitbucket';
  }

  /**
   * Post a comment on a BitBucket PR or issue
   * @param reference PR URL (https://bitbucket.org/…/pull-requests/123) or issue reference (workspace/repo#42 or 42)
   * @param body Markdown comment body
   */
  async createComment(reference: string, body: string): Promise<void> {
    if (
      reference.includes('bitbucket.org') &&
      reference.includes('pull-requests')
    ) {
      const { workspace, repo, prId } = this.parsePullRequestUrl(reference);
      await this.bitbucket.pullrequests.createComment({
        workspace,
        repo_slug: repo,
        pull_request_id: prId,
        _body: { type: 'pullrequest_comment', content: { raw: body } },
      });
    } else {
      const { workspace, repo, issueId } = this.parseReference(reference);
      await this.bitbucket.issue.createComment({
        workspace,
        repo_slug: repo,
        issue_id: issueId,
        _body: { content: { raw: body } },
      });
    }
  }

  /**
   * Post an inline (line-level) comment on a BitBucket PR diff.
   * @param prUrl Full PR URL
   * @param filePath Diff-relative file path (e.g. "src/foo/bar.ts")
   * @param line Destination-side line number to anchor the comment to
   * @param body Markdown comment body
   */
  async createInlineComment(
    prUrl: string,
    filePath: string,
    line: number,
    body: string,
  ): Promise<void> {
    const { workspace, repo, prId } = this.parsePullRequestUrl(prUrl);
    await this.bitbucket.pullrequests.createComment({
      workspace,
      repo_slug: repo,
      pull_request_id: prId,
      _body: {
        type: 'pullrequest_comment',
        content: { raw: body },
        inline: { path: filePath, to: line },
      },
    });
  }

  /**
   * Find an open pull request whose source branch name contains the ticket key
   * @param ticketKey Ticket key to search for (e.g. "WBP-2955")
   * @param repoOverride Optional repo in "workspace/repo" format; falls back to default
   * @returns PR URL if found, null otherwise
   */
  async findPullRequestByTicketKey(
    ticketKey: string,
    repoOverride?: string,
  ): Promise<string | null> {
    const { workspace, repo } = this.parseProjectOrDefault(repoOverride);

    const response = await this.bitbucket.pullrequests.list({
      workspace,
      repo_slug: repo,
      q: `source.branch.name ~ "${ticketKey}"`,
    });

    const prs = response.data.values;
    if (!prs || prs.length === 0) return null;

    return prs[0].links?.html?.href ?? null;
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
   * Search issues on BitBucket
   */
  async searchTickets(query: string): Promise<UniversalTicket[]> {
    const { workspace, repo } = this.parseProjectOrDefault();

    const response = await this.bitbucket.issue.list({
      workspace,
      repo_slug: repo,
      q: query,
    });

    const issues = response.data.values || [];

    return issues.map(
      (issue: any) =>
        new UniversalTicket({
          key: `${workspace}/${repo}#${issue.id}`,
          title: issue.title,
          description: issue.content?.raw || '',
          type: this.mapBitBucketTypeToUniversal(issue.kind),
          status: issue.state,
          priority: this.mapBitBucketPriorityToUniversal(issue.priority),
          assignee: issue.assignee?.display_name,
          reporter: issue.reporter?.display_name,
          created: new Date(issue.created_on),
          updated: new Date(issue.updated_on),
          project: `${workspace}/${repo}`,
          platformData: {
            bitbucketId: issue.id,
            bitbucketUrl: issue.links?.html?.href,
          },
        }),
    );
  }

  /**
   * Parse project string or use default
   */
  private parseProjectOrDefault(project?: string): {
    workspace: string;
    repo: string;
  } {
    if (project && project.includes('/')) {
      const [workspace, repo] = project.split('/');
      return { workspace, repo };
    }

    if (project && this.defaultWorkspace) {
      return { workspace: this.defaultWorkspace, repo: project };
    }

    throw new Error(
      'No BitBucket repository specified. Provide the repository as "workspace/repo".',
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
      return { workspace, repo, issueId: parseInt(id, 10) };
    }

    throw new Error(
      `Invalid BitBucket issue reference: "${reference}". Expected format: workspace/repo#123`,
    );
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
    const match = url.match(
      /bitbucket\.org\/([^\/]+)\/([^\/]+)\/pull-requests\/(\d+)/,
    );
    if (!match) {
      throw new Error(`Invalid BitBucket PR URL: ${url}`);
    }

    return {
      workspace: match[1],
      repo: match[2],
      prId: parseInt(match[3], 10),
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
   * Map UniversalTicket priority to BitBucket priority
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
   * Map BitBucket priority to UniversalTicket priority
   */
  private mapBitBucketPriorityToUniversal(
    bitbucketPriority: string,
  ): TicketPriority {
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
