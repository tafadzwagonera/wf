import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Bitbucket } from 'bitbucket';
import { IssueTrackerAdapter, IssueTrackerFeature } from '../issue-tracker-adapter.interface';
import { ValidationError } from '../../../common/utils/errors';
import {
  UniversalTicket,
  IssueTrackerTicketReference,
  TicketType,
  TicketPriority,
} from '../../../common/dto/universal-ticket.dto';
import { LoggerService } from '../../../common/logger/logger.service';
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

  async getTicket(reference: string): Promise<UniversalTicket> {
    const { workspace, repo, issueId } = this.parseReference(reference);
    const response = await this.bitbucket.issue.get({ workspace, repo_slug: repo, issue_id: issueId });
    return this.mapBitbucketIssueToUniversal(response.data, workspace, repo);
  }

  async updateTicket(reference: string, updates: Partial<UniversalTicket>): Promise<void> {
    const { workspace, repo, issueId } = this.parseReference(reference);
    await this.bitbucket.issue.update({
      workspace,
      repo_slug: repo,
      issue_id: issueId,
      _body: this.buildBitbucketUpdateBody(updates),
    });
  }

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

  getTrackerName(): string {
    return 'bitbucket';
  }

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

  async findPullRequestByTicketKey(ticketKey: string, repoOverride?: string): Promise<string | null> {
    const matches = await this.findPullRequestsByTicketKey(ticketKey, repoOverride);

    return matches[0] ?? null;
  }

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

  async getPullRequestDiff(url: string): Promise<string> {
    const { workspace, repo, prId } = this.parsePullRequestUrl(url);

    const response = await this.bitbucket.pullrequests.getDiff({
      workspace,
      repo_slug: repo,
      pull_request_id: prId,
    });

    return response.data as unknown as string;
  }

  private buildBitbucketCreateBody(ticket: UniversalTicket): Record<string, unknown> {
    return {
      title: ticket.title,
      content: { raw: ticket.description },
      kind: this.mapTicketTypeToBitBucket(ticket.type),
      priority: this.mapPriorityToBitBucket(ticket.priority),
    };
  }

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

  private buildBitbucketUpdateBody(updates: Partial<UniversalTicket>): Record<string, unknown> {
    const body: Record<string, unknown> = {};
    if (updates.title) body.title = updates.title;
    if (updates.description !== undefined) body.content = { raw: updates.description };
    if (updates.status) body.state = updates.status;
    if (updates.type) body.kind = this.mapTicketTypeToBitBucket(updates.type);
    if (updates.priority) body.priority = this.mapPriorityToBitBucket(updates.priority);
    return body;
  }

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

  private mapBitBucketTypeToUniversal(bitbucketKind: string): TicketType {
    const typeMap: Record<string, TicketType> = {
      task: TicketType.TASK,
      bug: TicketType.BUG,
      enhancement: TicketType.STORY,
      proposal: TicketType.EPIC,
    };

    return typeMap[bitbucketKind] || TicketType.TASK;
  }

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
