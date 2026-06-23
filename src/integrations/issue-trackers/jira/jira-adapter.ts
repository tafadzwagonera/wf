import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JiraService } from '../../jira/jira.service';
import { IssueTrackerAdapter, IssueTrackerFeature } from '../issue-tracker-adapter.interface';
import {
  UniversalTicket,
  IssueTrackerTicketReference,
  TicketType,
  TicketPriority,
} from '../../../common/dto/universal-ticket.dto';
import { CreateTicketRequest, UpdateTicketRequest } from '../../jira/dto/jira.dto';

const JIRA_NEUTRAL_PRIORITY = 'Medium';

/**
 * Jira platform adapter implementing IssueTrackerAdapter interface
 * Wraps JiraService to provide tracker-agnostic operations
 */
@Injectable()
export class JiraAdapter implements IssueTrackerAdapter {
  constructor(
    private readonly jiraService: JiraService,
    private readonly configService: ConfigService
  ) {}

  /**
   * Create a ticket on Jira
   */
  async createTicket(ticket: UniversalTicket): Promise<IssueTrackerTicketReference> {
    const request = this.buildCreateRequest(ticket);

    const ticketKey = await this.jiraService.createTicket(request);

    return {
      tracker: 'jira',
      id: ticketKey,
      key: ticketKey,
      url: this.getTicketUrl(ticketKey),
    };
  }

  /**
   * Map a universal ticket into the Jira create-ticket request shape.
   *
   * @param ticket - Universal ticket to convert
   * @returns Jira create request
   */
  buildCreateRequest(ticket: UniversalTicket): CreateTicketRequest {
    return {
      project: ticket.project || '',
      summary: ticket.title,
      description: ticket.description,
      issueType: this.mapTicketTypeToJira(ticket.type),
      priority: this.mapPriorityToJira(ticket.priority),
      labels: ticket.labels,
      assignee: ticket.assignee,
      components: ticket.components,
    };
  }

  /**
   * Build the Jira REST payload used for issue creation without any network I/O.
   *
   * @param ticket - Universal ticket to convert
   * @returns Jira create payload for preview/debugging
   */
  buildCreatePayload(ticket: UniversalTicket): {
    fields: Record<string, unknown>;
  } {
    return this.jiraService.buildCreatePayload(this.buildCreateRequest(ticket));
  }

  /**
   * Get a ticket from Jira
   */
  async getTicket(reference: string): Promise<UniversalTicket> {
    const jiraTicket = await this.jiraService.getTicket(reference);

    return new UniversalTicket({
      key: jiraTicket.key,
      title: jiraTicket.summary,
      description: jiraTicket.description,
      type: this.mapJiraTypeToUniversal(jiraTicket.issueType),
      status: jiraTicket.status.toLowerCase(),
      priority: this.mapJiraPriorityToUniversal(jiraTicket.priority),
      assignee: jiraTicket.assignee,
      reporter: jiraTicket.reporter,
      created: jiraTicket.created,
      updated: jiraTicket.updated,
      labels: jiraTicket.labels,
      components: jiraTicket.components,
      trackerData: {
        jiraId: jiraTicket.id,
        jiraKey: jiraTicket.key,
      },
    });
  }

  /**
   * Update a ticket on Jira
   */
  async updateTicket(reference: string, updates: Partial<UniversalTicket>): Promise<void> {
    const request: UpdateTicketRequest = {};

    if (updates.title) {
      request.summary = updates.title;
    }
    if (updates.description) {
      request.description = updates.description;
    }
    if (updates.priority) {
      request.priority = this.mapPriorityToJira(updates.priority);
    }
    if (updates.labels) {
      request.labels = updates.labels;
    }
    if (updates.assignee) {
      request.assignee = updates.assignee;
    }

    await this.jiraService.updateTicket(reference, request);
  }

  /**
   * Check if Jira supports a feature
   */
  supports(feature: IssueTrackerFeature): boolean {
    const supportedFeatures = [
      IssueTrackerFeature.CREATE_TICKET,
      IssueTrackerFeature.GET_TICKET,
      IssueTrackerFeature.UPDATE_TICKET,
      IssueTrackerFeature.SEARCH_TICKETS,
      IssueTrackerFeature.ADD_LABELS,
      IssueTrackerFeature.ASSIGN_TICKET,
    ];

    return supportedFeatures.includes(feature);
  }

  /**
   * Get platform name
   */
  getTrackerName(): string {
    return 'jira';
  }

  /**
   * Search tickets on Jira
   */
  async searchTickets(query: string): Promise<UniversalTicket[]> {
    const jiraTickets = await this.jiraService.searchTickets({
      jql: query,
      maxResults: 50,
    });

    return jiraTickets.map(
      jiraTicket =>
        new UniversalTicket({
          key: jiraTicket.key,
          title: jiraTicket.summary,
          description: jiraTicket.description,
          type: this.mapJiraTypeToUniversal(jiraTicket.issueType),
          status: jiraTicket.status.toLowerCase(),
          priority: this.mapJiraPriorityToUniversal(jiraTicket.priority),
          assignee: jiraTicket.assignee,
          reporter: jiraTicket.reporter,
          created: jiraTicket.created,
          updated: jiraTicket.updated,
          labels: jiraTicket.labels,
          components: jiraTicket.components,
          trackerData: {
            jiraId: jiraTicket.id,
            jiraKey: jiraTicket.key,
          },
        })
    );
  }

  /**
   * Map UniversalTicket type to Jira issue type
   */
  private mapTicketTypeToJira(type?: TicketType): string {
    if (!type) return 'Task';

    const typeMap: Record<string, string> = {
      [TicketType.TASK]: 'Task',
      [TicketType.BUG]: 'Bug',
      [TicketType.STORY]: 'Story',
      [TicketType.TODO]: 'Task',
      [TicketType.EPIC]: 'Epic',
      [TicketType.SUBTASK]: 'Sub-task',
    };

    return typeMap[type] || 'Task';
  }

  /**
   * Map Jira issue type to UniversalTicket type
   */
  private mapJiraTypeToUniversal(jiraType: string): TicketType {
    const normalizedType = jiraType.toLowerCase();

    const typeMap: Record<string, TicketType> = {
      task: TicketType.TASK,
      bug: TicketType.BUG,
      story: TicketType.STORY,
      epic: TicketType.EPIC,
      'sub-task': TicketType.SUBTASK,
      subtask: TicketType.SUBTASK,
    };

    return typeMap[normalizedType] || TicketType.TASK;
  }

  /**
   * Map a normalized wf priority to Jira's create/update payload values.
   *
   * Jira does not guarantee a fixed priority list across instances, so this
   * adapter only provides the platform-local fallback mapping. The Jira
   * service performs runtime resolution against the instance's configured
   * priorities when creating tickets.
   */
  private mapPriorityToJira(priority?: TicketPriority): string {
    if (!priority) return JIRA_NEUTRAL_PRIORITY;

    const priorityMap: Record<string, string> = {
      [TicketPriority.HIGHEST]: 'Highest',
      [TicketPriority.HIGH]: 'High',
      [TicketPriority.MEDIUM]: 'Medium',
      [TicketPriority.LOW]: 'Low',
      [TicketPriority.LOWEST]: 'Lowest',
    };

    return priorityMap[priority] ?? JIRA_NEUTRAL_PRIORITY;
  }

  /**
   * Map a Jira priority name back to the normalized wf priority enum.
   *
   * Jira priority names are instance-specific, so we collapse them into the
   * shared internal priority vocabulary rather than preserving raw names.
   */
  private mapJiraPriorityToUniversal(jiraPriority: string): TicketPriority {
    const normalizedPriority = jiraPriority.toLowerCase();

    const priorityMap: Record<string, TicketPriority> = {
      highest: TicketPriority.HIGHEST,
      high: TicketPriority.HIGH,
      medium: TicketPriority.MEDIUM,
      low: TicketPriority.LOW,
      lowest: TicketPriority.LOWEST,
      none: TicketPriority.MEDIUM,
    };

    return priorityMap[normalizedPriority] || TicketPriority.MEDIUM;
  }

  /**
   * Get Jira ticket URL using ATLASSIAN_BASE_URL from config
   */
  private getTicketUrl(ticketKey: string): string {
    const baseUrl = this.configService.get<string>('atlassian.baseUrl') ?? '';
    return `${baseUrl}/browse/${ticketKey}`;
  }
}
