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
import { stripInlineMarkdownDelimiters } from '../../common/utils/markdown-text';

/**
 * Normalize near-markdown formatting that commonly appears in generated Jira
 * ticket artifacts before converting the content to ADF.
 *
 * @param markdown - Raw description content from the ticket artifact
 * @returns Markdown normalized for the ADF parser
 */
const normalizeMarkdownForADF = (markdown: string): string =>
  markdown
    .replace(
      /\{code(?::([^}\n]+))?\}([\s\S]*?)\{code\}/g,
      (_match, language: string | undefined, code: string) => {
        const lang = language?.trim() ?? '';
        return `\`\`\`${lang}\n${code.trim()}\n\`\`\``;
      },
    )
    .replace(
      /\{noformat\}([\s\S]*?)\{noformat\}/g,
      (_match, content: string) => `\`\`\`\n${content.trim()}\n\`\`\``,
    )
    .replace(/^[ \t]*\*\s+/gm, '- ');

/**
 * Convert Jira wiki markup patterns embedded in ADF text content into
 * standard markdown so downstream consumers receive clean output.
 *
 * @param text - Raw markdown output from ADF text nodes
 * @returns Markdown with wiki markup patterns normalized
 */
const normalizeWikiMarkupInMarkdown = (text: string): string =>
  text
    .replace(
      /\{code(?::([^}\n]+))?\}([\s\S]*?)\{code\}/g,
      (_match, language: string | undefined, code: string) => {
        const lang = language?.trim() ?? '';
        return `\`\`\`${lang}\n${code.trim()}\n\`\`\``;
      },
    )
    .replace(
      /\{noformat\}([\s\S]*?)\{noformat\}/g,
      (_match, content: string) => `\`\`\`\n${content.trim()}\n\`\`\``,
    )
    .replace(/\{\{([^}]+)\}\}/g, (_match, content: string) => `\`${content}\``)
    .replace(/^(# .+(?:\n# .+)+)$/gm, (block) => {
      const items = block.split('\n');
      return items
        .map((line, i) => `${i + 1}. ${line.replace(/^#\s+/, '')}`)
        .join('\n');
    })
    .replace(/^\*\s+/gm, '- ');

interface BuildCreatePayloadOptions {
  priorityName?: string | null;
}

const PRIORITY_ALIAS_NAMES = {
  highest: ['Highest', 'Blocker', 'Critical'],
  high: ['High', 'Major'],
  medium: ['Medium', 'Minor'],
  low: ['Low', 'Trivial'],
  lowest: ['Lowest', 'Trivial'],
} as const;

type JiraCreateIssueType = {
  id: string;
  name: string;
};

type JiraAllowedPriority = {
  id?: string;
  name: string;
};

type JiraCreateField = {
  key?: string;
  fieldId?: string;
  name?: string;
  allowedValues?: JiraAllowedPriority[];
};

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
          'Jira credentials not configured. Set atlassian.baseUrl, atlassian.email, and atlassian.jira.apiToken in wf.config.*.',
        );
      }
    }
  }

  private ensureConfigured(): void {
    if (!this.baseUrl || !this.email || !this.apiToken) {
      throw new JiraApiError(
        'Jira is not configured. Set atlassian.baseUrl, atlassian.email, and atlassian.jira.apiToken in wf.config.*.',
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
  async resolveValidPriorityName(
    requested: string,
  ): Promise<string | undefined> {
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

  /**
   * Resolve a requested priority against the priorities allowed when creating
   * the target project's issue type.
   *
   * @param projectKey - Jira project key used for the create request
   * @param issueTypeName - Jira issue type name used for the create request
   * @param requestedPriority - User-requested or adapter-mapped priority name
   * @returns Allowed Jira priority name, or undefined when priority is unavailable
   */
  async resolveCreatePriorityName(
    projectKey: string,
    issueTypeName: string,
    requestedPriority: string,
  ): Promise<string | undefined> {
    try {
      const issueTypeId = await this.resolveCreateIssueTypeId(
        projectKey,
        issueTypeName,
      );
      if (!issueTypeId) {
        return this.resolveValidPriorityName(requestedPriority);
      }

      const allowedPriorities = await this.fetchCreateAllowedPriorities(
        projectKey,
        issueTypeId,
      );
      if (!allowedPriorities) {
        return undefined;
      }

      return this.matchAllowedPriority(requestedPriority, allowedPriorities);
    } catch {
      return this.resolveValidPriorityName(requestedPriority);
    }
  }

  /**
   * Resolve an issue type name to its Jira ID for create metadata lookups.
   *
   * @param projectKey - Jira project key
   * @param issueTypeName - Jira issue type name to match case-insensitively
   * @returns Jira issue type ID, or undefined when no match is available
   */
  private async resolveCreateIssueTypeId(
    projectKey: string,
    issueTypeName: string,
  ): Promise<string | undefined> {
    const url = `${this.baseUrl}/rest/api/3/issue/createmeta/${encodeURIComponent(
      projectKey,
    )}/issuetypes`;
    const response = await firstValueFrom(
      this.httpService.get(url, { headers: this.getAuthHeaders() }),
    );
    const issueTypes = this.extractCreateIssueTypes(response.data);
    const lowerIssueTypeName = issueTypeName.toLowerCase();
    return issueTypes.find(
      (issueType) => issueType.name.toLowerCase() === lowerIssueTypeName,
    )?.id;
  }

  /**
   * Fetch allowed priority values from Jira create metadata.
   *
   * @param projectKey - Jira project key
   * @param issueTypeId - Jira issue type ID
   * @returns Allowed priority values, undefined when priority is not on screen
   */
  private async fetchCreateAllowedPriorities(
    projectKey: string,
    issueTypeId: string,
  ): Promise<JiraAllowedPriority[] | undefined> {
    const url = `${this.baseUrl}/rest/api/3/issue/createmeta/${encodeURIComponent(
      projectKey,
    )}/issuetypes/${encodeURIComponent(issueTypeId)}`;
    const response = await firstValueFrom(
      this.httpService.get(url, { headers: this.getAuthHeaders() }),
    );
    const priorityField = this.extractCreatePriorityField(response.data);
    return priorityField?.allowedValues;
  }

  /**
   * Extract issue type records from Jira's create metadata response.
   *
   * @param data - Raw Jira create issue-types response
   * @returns Issue type records with IDs and names
   */
  private extractCreateIssueTypes(data: unknown): JiraCreateIssueType[] {
    const issueTypes = (data as { issueTypes?: unknown })?.issueTypes;
    if (!Array.isArray(issueTypes)) {
      return [];
    }

    return issueTypes.filter((issueType): issueType is JiraCreateIssueType =>
      Boolean(
        issueType &&
        typeof issueType === 'object' &&
        typeof (issueType as JiraCreateIssueType).id === 'string' &&
        typeof (issueType as JiraCreateIssueType).name === 'string',
      ),
    );
  }

  /**
   * Extract the priority field from Jira's create field metadata.
   *
   * @param data - Raw Jira create fields response
   * @returns Priority field metadata, or undefined when absent
   */
  private extractCreatePriorityField(
    data: unknown,
  ): JiraCreateField | undefined {
    const fields = (data as { fields?: unknown })?.fields;
    if (Array.isArray(fields)) {
      return fields.find((field): field is JiraCreateField =>
        this.isPriorityCreateField(field),
      );
    }

    const priorityField = (fields as { priority?: unknown } | undefined)
      ?.priority;
    return this.isCreateFieldWithAllowedValues(priorityField)
      ? priorityField
      : undefined;
  }

  /**
   * Check whether a create metadata field is Jira's priority field.
   *
   * @param field - Raw create metadata field
   * @returns True when the field represents priority and has allowed values
   */
  private isPriorityCreateField(field: unknown): field is JiraCreateField {
    if (!this.isCreateFieldWithAllowedValues(field)) return false;

    const createField = field;
    const fieldKey = createField.key ?? createField.fieldId;
    const isPriority =
      fieldKey === 'priority' || createField.name?.toLowerCase() === 'priority';
    return isPriority;
  }

  /**
   * Check whether a create metadata value is a field with allowed values.
   *
   * @param field - Raw create metadata field
   * @returns True when the field has an allowed values array
   */
  private isCreateFieldWithAllowedValues(
    field: unknown,
  ): field is JiraCreateField {
    return Boolean(
      field &&
      typeof field === 'object' &&
      Array.isArray((field as JiraCreateField).allowedValues),
    );
  }

  /**
   * Match a requested priority to an allowed Jira create priority.
   *
   * @param requestedPriority - Requested priority name
   * @param allowedPriorities - Priority values allowed by create metadata
   * @returns Matched Jira priority name, or undefined when no match exists
   */
  private matchAllowedPriority(
    requestedPriority: string,
    allowedPriorities: JiraAllowedPriority[],
  ): string | undefined {
    const lowerRequestedPriority = requestedPriority.toLowerCase();
    const exactMatch = allowedPriorities.find(
      (priority) => priority.name.toLowerCase() === lowerRequestedPriority,
    );
    if (exactMatch) {
      return exactMatch.name;
    }

    const aliasNames =
      PRIORITY_ALIAS_NAMES[
        lowerRequestedPriority as keyof typeof PRIORITY_ALIAS_NAMES
      ] ?? [];
    const lowerAliasNames = new Set(
      aliasNames.map((aliasName) => aliasName.toLowerCase()),
    );
    return allowedPriorities.find((priority) =>
      lowerAliasNames.has(priority.name.toLowerCase()),
    )?.name;
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

    // Resolve priority against create metadata for the selected project/type.
    let resolvedPriority: string | undefined;
    if (request.priority) {
      resolvedPriority = await this.resolveCreatePriorityName(
        project,
        request.issueType || 'Task',
        request.priority,
      );
      if (!resolvedPriority) {
        this.logger.warn(
          `Priority "${request.priority}" is not allowed for ${project} ${request.issueType || 'Task'} creates. Creating ticket without priority.`,
        );
      }
    }

    try {
      const payload = this.buildCreatePayload(
        { ...request, project },
        { priorityName: resolvedPriority ?? null },
      );

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
        // Some Jira schemes reject valid-looking priorities during create.
        // Retry once without priority so ticket creation can still succeed.
        const retryPayload = this.buildCreatePayload(
          { ...request, project },
          { priorityName: null },
        );
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

  /**
   * Build the Jira create-issue payload without performing any network calls.
   *
   * @param request - Create ticket request mapped to Jira field names
   * @param options - Payload options such as a resolved priority name
   * @returns Jira REST API payload for issue creation
   */
  buildCreatePayload(
    request: CreateTicketRequest,
    options: BuildCreatePayloadOptions = {},
  ): { fields: Record<string, unknown> } {
    const project = request.project || this.defaultProject;
    if (!project) {
      throw new JiraApiError(
        'No project specified and no default project configured',
      );
    }

    const priorityName = Object.prototype.hasOwnProperty.call(
      options,
      'priorityName',
    )
      ? options.priorityName
      : request.priority;

    return {
      fields: {
        project: { key: project },
        summary: stripInlineMarkdownDelimiters(request.summary),
        description: this.markdownToADF(request.description),
        issuetype: { name: request.issueType || 'Task' },
        ...(priorityName && { priority: { name: priorityName } }),
        ...(request.labels && { labels: request.labels }),
        ...(request.assignee && {
          assignee: { accountId: request.assignee },
        }),
        ...(request.components && {
          components: request.components.map((name) => ({ name })),
        }),
      },
    };
  }

  /**
   * Build the Jira update payload without performing any network calls.
   *
   * @param updates - Partial Jira update request mapped to Jira field names
   * @returns Jira REST API payload for issue updates
   */
  buildUpdatePayload(updates: UpdateTicketRequest): {
    fields: Record<string, unknown>;
  } {
    return {
      fields: {
        ...(updates.summary && {
          summary: stripInlineMarkdownDelimiters(updates.summary),
        }),
        ...(updates.description && {
          description: this.markdownToADF(updates.description),
        }),
        ...(updates.priority && {
          priority: { name: updates.priority },
        }),
        ...(updates.labels && { labels: updates.labels }),
        ...(updates.assignee && {
          assignee: { accountId: updates.assignee },
        }),
      },
    };
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
      const payload = this.buildUpdatePayload(updates);
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
    const lines = normalizeMarkdownForADF(markdown).split('\n');
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

      const listItemMatch = this.matchListItem(line);
      if (listItemMatch) {
        const { node, nextIndex } = this.parseList(lines, i, listItemMatch);
        content.push(node);
        i = nextIndex;
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

  /**
   * Match a markdown list item and capture its indentation, type, and text.
   *
   * @param line - Raw markdown line
   * @returns Parsed list item metadata when the line is a list item
   */
  private matchListItem(line: string):
    | {
        indent: number;
        listType: 'bulletList' | 'orderedList';
        text: string;
      }
    | undefined {
    const bulletMatch = line.match(/^(\s*)[-*]\s+(.+)$/);
    if (bulletMatch) {
      return {
        indent: bulletMatch[1].length,
        listType: 'bulletList',
        text: bulletMatch[2],
      };
    }

    const orderedMatch = line.match(/^(\s*)\d+\.\s+(.+)$/);
    if (orderedMatch) {
      return {
        indent: orderedMatch[1].length,
        listType: 'orderedList',
        text: orderedMatch[2],
      };
    }

    return undefined;
  }

  /**
   * Parse a markdown list block into nested Jira ADF list nodes.
   *
   * @param lines - Full markdown split by lines
   * @param startIndex - First list-item line index
   * @param rootMatch - Parsed metadata for the first list item
   * @returns Parsed ADF list node and the next unread line index
   */
  private parseList(
    lines: string[],
    startIndex: number,
    rootMatch: {
      indent: number;
      listType: 'bulletList' | 'orderedList';
      text: string;
    },
  ): { node: any; nextIndex: number } {
    const listItems: any[] = [];
    let index = startIndex;

    while (index < lines.length) {
      const listItemMatch = this.matchListItem(lines[index]);
      if (!listItemMatch) {
        break;
      }

      if (listItemMatch.indent < rootMatch.indent) {
        break;
      }

      if (
        listItemMatch.indent > rootMatch.indent ||
        listItemMatch.listType !== rootMatch.listType
      ) {
        break;
      }

      const listItem: any = {
        type: 'listItem',
        content: [
          {
            type: 'paragraph',
            content: this.parseInlineMarkdown(listItemMatch.text),
          },
        ],
      };
      index += 1;

      while (index < lines.length) {
        const nestedListItemMatch = this.matchListItem(lines[index]);

        if (!nestedListItemMatch) {
          break;
        }

        if (nestedListItemMatch.indent <= rootMatch.indent) {
          break;
        }

        const nestedList = this.parseList(lines, index, nestedListItemMatch);
        listItem.content.push(nestedList.node);
        index = nestedList.nextIndex;
      }

      listItems.push(listItem);
    }

    return {
      node: {
        type: rootMatch.listType,
        content: listItems,
      },
      nextIndex: index,
    };
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

    const raw = adf.content
      .map((node: any) => this.processADFNode(node))
      .join('');

    return normalizeWikiMarkupInMarkdown(raw);
  }

  private processADFNode(node: any): string {
    switch (node.type) {
      case 'paragraph':
        return this.processADFContent(node.content) + '\n\n';
      case 'heading': {
        const level = '#'.repeat(node.attrs.level);
        return `${level} ${this.processADFContent(node.content)}\n\n`;
      }
      case 'bulletList':
        return (
          node.content
            .map(
              (item: any) => `- ${this.processADFContent(item.content).trim()}`,
            )
            .join('\n') + '\n\n'
        );
      case 'orderedList':
        return (
          node.content
            .map(
              (item: any, i: number) =>
                `${i + 1}. ${this.processADFContent(item.content).trim()}`,
            )
            .join('\n') + '\n\n'
        );
      case 'codeBlock': {
        const lang = node.attrs?.language || '';
        return `\`\`\`${lang}\n${this.processADFContent(node.content)}\n\`\`\`\n\n`;
      }
      case 'listItem':
        return this.processADFContent(node.content);
      case 'hardBreak':
        return '\n';
      case 'blockquote':
        return (
          (node.content || [])
            .map((child: any) =>
              this.processADFNode(child)
                .replace(/\n+$/, '')
                .split('\n')
                .map((line: string) => `> ${line}`)
                .join('\n'),
            )
            .join('\n') + '\n\n'
        );
      case 'rule':
        return '---\n\n';
      case 'table':
        return this.processADFTable(node) + '\n\n';
      case 'inlineCard':
        return node.attrs?.url || '[card]';
      case 'mention':
        return node.attrs?.text || '@unknown';
      case 'emoji':
        return node.attrs?.shortName || node.attrs?.text || '';
      case 'expand':
      case 'nestedExpand': {
        const title = node.attrs?.title;
        const body = (node.content || [])
          .map((child: any) => this.processADFNode(child))
          .join('');
        return title ? `**${title}**\n\n${body}` : body;
      }
      case 'panel':
        return (node.content || [])
          .map((child: any) => this.processADFNode(child))
          .join('');
      case 'status':
        return node.attrs?.text || '';
      case 'date':
        return node.attrs?.timestamp
          ? new Date(Number(node.attrs.timestamp)).toISOString().split('T')[0]
          : '';
      case 'mediaSingle':
      case 'mediaGroup':
        return '[media]\n\n';
      default:
        return this.processADFContent(node.content || []);
    }
  }

  private processADFTable(node: any): string {
    const rows: string[] = [];
    for (const row of node.content || []) {
      const cells = (row.content || []).map((cell: any) =>
        this.processADFContent(cell.content).trim(),
      );
      rows.push(`| ${cells.join(' | ')} |`);
      if (rows.length === 1) {
        rows.push(`| ${cells.map(() => '---').join(' | ')} |`);
      }
    }
    return rows.join('\n');
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
                case 'strike':
                  text = `~~${text}~~`;
                  break;
                case 'link':
                  text = `[${text}](${mark.attrs.href})`;
                  break;
              }
            });
          }
          return text;
        }
        return this.processADFNode(node);
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
