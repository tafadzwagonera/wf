import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import {
  CreateTicketRequest,
  JiraTicket,
  UpdateTicketRequest,
  JiraSearchRequest,
} from './dto/jira.dto';
import { JiraApiError } from '../../shared/utils/errors';
import { LoggerService } from '../../shared/logger/logger.service';
import { PlatformConfigService } from '../platforms/platform-config.service';

@Injectable()
export class JiraService {
  private baseUrl?: string;
  private email?: string;
  private apiToken?: string;
  private defaultProject?: string;

  constructor(
    private configService: ConfigService,
    private httpService: HttpService,
    private logger: LoggerService,
    private platformConfig: PlatformConfigService,
  ) {
    this.baseUrl = this.configService.get<string>('atlassian.baseUrl');
    this.email = this.configService.get<string>('atlassian.email');
    this.apiToken = this.configService.get<string>('atlassian.apiToken');
    this.defaultProject = this.configService.get<string>(
      'atlassian.jira.defaultProject',
    );

    // Check if platform has any configuration (partial config detection)
    const hasPartialConfig = Boolean(
      this.baseUrl || this.email || this.apiToken || this.defaultProject,
    );

    if (!this.baseUrl || !this.email || !this.apiToken) {
      // Only warn if platform is enabled
      if (this.platformConfig.isPlatformEnabled('jira', hasPartialConfig)) {
        this.logger.warn(
          'Jira credentials not configured. Set ATLASSIAN_BASE_URL, ATLASSIAN_EMAIL, and ATLASSIAN_JIRA_API_TOKEN in .env',
        );
      }
    }
  }

  private ensureConfigured(): void {
    if (!this.baseUrl || !this.email || !this.apiToken) {
      throw new JiraApiError(
        'Jira is not configured. Please set ATLASSIAN_BASE_URL, ATLASSIAN_EMAIL, and ATLASSIAN_JIRA_API_TOKEN in your .env file.',
        null,
        false,
      );
    }
  }

  /**
   * Fetch all available Jira priorities and return the exact name that
   * matches the requested priority (case-insensitive). Returns undefined
   * if no match is found or the fetch fails.
   */
  async resolveValidPriorityName(requested: string): Promise<string | undefined> {
    try {
      const url = `${this.baseUrl}/rest/api/3/priority`;
      const response = await firstValueFrom(
        this.httpService.get(url, { headers: this.getAuthHeaders() }),
      );
      const priorities: Array<{ id: string; name: string }> = response.data;
      const lower = requested.toLowerCase();
      const match = priorities.find((p) => p.name.toLowerCase() === lower);
      return match?.name;
    } catch {
      return undefined;
    }
  }

  private getAuthHeaders() {
    const auth = Buffer.from(`${this.email}:${this.apiToken}`).toString(
      'base64',
    );
    return {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    };
  }

  async createTicket(request: CreateTicketRequest): Promise<string> {
    this.ensureConfigured();

    const project = request.project || this.defaultProject;
    if (!project) {
      throw new JiraApiError(
        'No project specified and no default project configured',
      );
    }

    try {
      const payload = {
        fields: {
          project: { key: project },
          summary: request.summary,
          description: this.markdownToADF(request.description),
          issuetype: { name: request.issueType || 'Task' },
          ...(request.priority && { priority: { name: request.priority } }),
          ...(request.labels && { labels: request.labels }),
          ...(request.assignee && {
            assignee: { accountId: request.assignee },
          }),
          ...(request.components && {
            components: request.components.map((name) => ({ name })),
          }),
        },
      };

      const url = `${this.baseUrl}/rest/api/3/issue`;
      const response = await firstValueFrom(
        this.httpService.post(url, payload, { headers: this.getAuthHeaders() }),
      );

      const ticketKey = response.data.key;
      this.logger.success(`Created Jira ticket: ${ticketKey}`);

      return ticketKey;
    } catch (error) {
      const isPriorityError =
        error?.response?.status === 400 &&
        error?.response?.data?.errors?.priority;

      if (isPriorityError) {
        this.logger.warn(
          `Priority rejected by Jira (${request.priority}). Retrying without priority field.`,
        );
        const retryPayload = {
          fields: {
            project: { key: project },
            summary: request.summary,
            description: this.markdownToADF(request.description),
            issuetype: { name: request.issueType || 'Task' },
            ...(request.labels && { labels: request.labels }),
            ...(request.assignee && {
              assignee: { accountId: request.assignee },
            }),
            ...(request.components && {
              components: request.components.map((name) => ({ name })),
            }),
          },
        };
        const url = `${this.baseUrl}/rest/api/3/issue`;
        const response = await firstValueFrom(
          this.httpService.post(url, retryPayload, {
            headers: this.getAuthHeaders(),
          }),
        );
        const ticketKey = response.data.key;
        this.logger.success(`Created Jira ticket: ${ticketKey}`);
        return ticketKey;
      }

      this.handleJiraError(error, 'create ticket');
    }
  }

  async getTicket(ticketKey: string): Promise<JiraTicket> {
    this.ensureConfigured();

    try {
      const url = `${this.baseUrl}/rest/api/3/issue/${ticketKey}`;
      const response = await firstValueFrom(
        this.httpService.get(url, { headers: this.getAuthHeaders() }),
      );

      const data = response.data;

      if (!data || !data.fields) {
        this.logger.error('Invalid response from Jira API', data);
        throw new JiraApiError('Invalid response structure from Jira API');
      }

      const fields = data.fields;

      return {
        key: data.key,
        id: data.id,
        summary: fields.summary,
        description: this.adfToMarkdown(fields.description),
        status: fields.status.name,
        issueType: fields.issuetype.name,
        priority: fields.priority?.name || 'None',
        assignee: fields.assignee?.displayName,
        reporter: fields.reporter?.displayName,
        created: new Date(fields.created),
        updated: new Date(fields.updated),
        labels: fields.labels || [],
        components: fields.components?.map((c: any) => c.name) || [],
      };
    } catch (error) {
      this.handleJiraError(error, `get ticket ${ticketKey}`);
    }
  }

  async updateTicket(
    ticketKey: string,
    updates: UpdateTicketRequest,
  ): Promise<void> {
    this.ensureConfigured();

    try {
      const payload: any = { fields: {} };

      if (updates.summary) payload.fields.summary = updates.summary;
      if (updates.description)
        payload.fields.description = this.markdownToADF(updates.description);
      if (updates.priority)
        payload.fields.priority = { name: updates.priority };
      if (updates.labels) payload.fields.labels = updates.labels;
      if (updates.assignee)
        payload.fields.assignee = { accountId: updates.assignee };

      const url = `${this.baseUrl}/rest/api/3/issue/${ticketKey}`;
      await firstValueFrom(
        this.httpService.put(url, payload, { headers: this.getAuthHeaders() }),
      );

      this.logger.success(`Updated Jira ticket: ${ticketKey}`);
    } catch (error) {
      this.handleJiraError(error, `update ticket ${ticketKey}`);
    }
  }

  async searchTickets(request: JiraSearchRequest): Promise<JiraTicket[]> {
    this.ensureConfigured();

    try {
      const url = `${this.baseUrl}/rest/api/3/search/jql`;
      const payload = {
        jql: request.jql,
        maxResults: request.maxResults || 50,
        fields: request.fields || [
          'summary',
          'description',
          'status',
          'issuetype',
          'priority',
          'assignee',
          'reporter',
          'created',
          'updated',
          'labels',
          'components',
        ],
      };

      const response = await firstValueFrom(
        this.httpService.post(url, payload, { headers: this.getAuthHeaders() }),
      );

      return response.data.issues.map((issue: any) =>
        this.mapIssueToTicket(issue),
      );
    } catch (error) {
      this.handleJiraError(error, 'search tickets');
    }
  }

  private mapIssueToTicket(issue: any): JiraTicket {
    const fields = issue.fields;
    return {
      key: issue.key,
      id: issue.id,
      summary: fields.summary,
      description: this.adfToMarkdown(fields.description),
      status: fields.status.name,
      issueType: fields.issuetype.name,
      priority: fields.priority?.name || 'None',
      assignee: fields.assignee?.displayName,
      reporter: fields.reporter?.displayName,
      created: new Date(fields.created),
      updated: new Date(fields.updated),
      labels: fields.labels || [],
      components: fields.components?.map((c: any) => c.name) || [],
    };
  }

  markdownToADF(markdown: string): any {
    if (!markdown) {
      return { type: 'doc', version: 1, content: [] };
    }

    const content: any[] = [];
    const lines = markdown.split('\n');
    let i = 0;

    while (i < lines.length) {
      const line = lines[i];

      // Skip empty lines
      if (!line.trim()) {
        i++;
        continue;
      }

      // Headers
      const headerMatch = line.match(/^(#{1,6})\s+(.+)$/);
      if (headerMatch) {
        content.push({
          type: 'heading',
          attrs: { level: headerMatch[1].length },
          content: [{ type: 'text', text: headerMatch[2] }],
        });
        i++;
        continue;
      }

      // Code blocks
      if (line.startsWith('```')) {
        const lang = line.substring(3).trim();
        const codeLines: string[] = [];
        i++;
        while (i < lines.length && !lines[i].startsWith('```')) {
          codeLines.push(lines[i]);
          i++;
        }
        content.push({
          type: 'codeBlock',
          attrs: lang ? { language: lang } : {},
          content: [{ type: 'text', text: codeLines.join('\n') }],
        });
        i++;
        continue;
      }

      // Bullet lists
      if (line.match(/^[-*]\s+/)) {
        const listItems: any[] = [];
        while (i < lines.length && lines[i].match(/^[-*]\s+/)) {
          const text = lines[i].replace(/^[-*]\s+/, '');
          listItems.push({
            type: 'listItem',
            content: [
              {
                type: 'paragraph',
                content: this.parseInlineMarkdown(text),
              },
            ],
          });
          i++;
        }
        content.push({ type: 'bulletList', content: listItems });
        continue;
      }

      // Ordered lists
      if (line.match(/^\d+\.\s+/)) {
        const listItems: any[] = [];
        while (i < lines.length && lines[i].match(/^\d+\.\s+/)) {
          const text = lines[i].replace(/^\d+\.\s+/, '');
          listItems.push({
            type: 'listItem',
            content: [
              {
                type: 'paragraph',
                content: this.parseInlineMarkdown(text),
              },
            ],
          });
          i++;
        }
        content.push({ type: 'orderedList', content: listItems });
        continue;
      }

      // Regular paragraph
      content.push({
        type: 'paragraph',
        content: this.parseInlineMarkdown(line),
      });
      i++;
    }

    return { type: 'doc', version: 1, content };
  }

  private parseInlineMarkdown(text: string): any[] {
    const content: any[] = [];
    let currentText = '';
    let i = 0;

    while (i < text.length) {
      // Bold **text**
      if (text.substring(i, i + 2) === '**') {
        if (currentText) {
          content.push({ type: 'text', text: currentText });
          currentText = '';
        }
        i += 2;
        let boldText = '';
        while (i < text.length && text.substring(i, i + 2) !== '**') {
          boldText += text[i];
          i++;
        }
        content.push({
          type: 'text',
          text: boldText,
          marks: [{ type: 'strong' }],
        });
        i += 2;
        continue;
      }

      // Italic *text*
      if (text[i] === '*' && text[i + 1] !== '*') {
        if (currentText) {
          content.push({ type: 'text', text: currentText });
          currentText = '';
        }
        i++;
        let italicText = '';
        while (i < text.length && text[i] !== '*') {
          italicText += text[i];
          i++;
        }
        content.push({
          type: 'text',
          text: italicText,
          marks: [{ type: 'em' }],
        });
        i++;
        continue;
      }

      // Inline code `text`
      if (text[i] === '`') {
        if (currentText) {
          content.push({ type: 'text', text: currentText });
          currentText = '';
        }
        i++;
        let codeText = '';
        while (i < text.length && text[i] !== '`') {
          codeText += text[i];
          i++;
        }
        content.push({
          type: 'text',
          text: codeText,
          marks: [{ type: 'code' }],
        });
        i++;
        continue;
      }

      currentText += text[i];
      i++;
    }

    if (currentText) {
      content.push({ type: 'text', text: currentText });
    }

    return content.length > 0 ? content : [{ type: 'text', text: '' }];
  }

  adfToMarkdown(adf: any): string {
    if (!adf || !adf.content) return '';

    return adf.content.map((node: any) => this.processADFNode(node)).join('');
  }

  private processADFNode(node: any): string {
    switch (node.type) {
      case 'paragraph':
        return this.processADFContent(node.content) + '\n\n';
      case 'heading':
        const level = '#'.repeat(node.attrs.level);
        return `${level} ${this.processADFContent(node.content)}\n\n`;
      case 'bulletList':
        return (
          node.content
            .map((item: any) => `- ${this.processADFContent(item.content)}`)
            .join('\n') + '\n\n'
        );
      case 'orderedList':
        return (
          node.content
            .map(
              (item: any, i: number) =>
                `${i + 1}. ${this.processADFContent(item.content)}`,
            )
            .join('\n') + '\n\n'
        );
      case 'codeBlock':
        const lang = node.attrs?.language || '';
        return `\`\`\`${lang}\n${this.processADFContent(node.content)}\n\`\`\`\n\n`;
      case 'listItem':
        return this.processADFContent(node.content);
      default:
        return this.processADFContent(node.content || []);
    }
  }

  private processADFContent(content: any[]): string {
    if (!content) return '';

    return content
      .map((node: any) => {
        if (node.type === 'text') {
          let text = node.text;
          if (node.marks) {
            node.marks.forEach((mark: any) => {
              switch (mark.type) {
                case 'strong':
                  text = `**${text}**`;
                  break;
                case 'em':
                  text = `*${text}*`;
                  break;
                case 'code':
                  text = `\`${text}\``;
                  break;
                case 'link':
                  text = `[${text}](${mark.attrs.href})`;
                  break;
              }
            });
          }
          return text;
        }
        if (node.type === 'paragraph') {
          return this.processADFContent(node.content);
        }
        return '';
      })
      .join('');
  }

  private handleJiraError(error: any, action: string): never {
    this.logger.error(`Failed to ${action}`, error);

    if (error.response) {
      const status = error.response.status;
      const data = error.response.data;

      if (status === 401) {
        throw new JiraApiError(
          'Authentication failed. Check your Jira email and API token.',
          { status, data },
          false,
        );
      }

      if (status === 403) {
        throw new JiraApiError(
          'Permission denied. You may not have access to this resource.',
          { status, data },
          false,
        );
      }

      if (status === 404) {
        throw new JiraApiError(
          `Resource not found when trying to ${action}`,
          { status, data },
          false,
        );
      }

      throw new JiraApiError(
        `Jira API error (${status}): ${data.errorMessages?.join(', ') || data.message || 'Unknown error'}`,
        { status, data },
        true,
      );
    }

    throw new JiraApiError(
      `Failed to ${action}: ${error.message}`,
      error,
      true,
    );
  }
}
