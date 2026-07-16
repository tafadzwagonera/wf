import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import { CreateTicketRequest, JiraSearchRequest, JiraTicket, UpdateTicketRequest } from './dto/jira.dto';
import { JiraApiError } from '../../shared/utils/errors';
import { LoggerService } from '../../shared/logger/logger.service';
import { IssueTrackerConfigService } from '../issue-trackers/issue-tracker-config.service';
import { stripInlineMarkdownDelimiters } from '../../common/utils/markdown-text';

const DEFAULT_SEARCH_FIELDS = [
  'assignee',
  'components',
  'created',
  'description',
  'issuetype',
  'labels',
  'priority',
  'reporter',
  'status',
  'summary',
  'updated',
] as const;

/**
 * Normalize near-markdown formatting that commonly appears in generated Jira
 * ticket artifacts before converting the content to ADF.
 *
 * @param markdown - Raw description content from the ticket artifact
 * @returns Markdown normalized for the ADF parser
 */
const normalizeMarkdownForADF = (markdown: string): string =>
  markdown
    .replaceAll(/\{code(?::([^}\n]+))?}([\s\S]*?)\{code}/g, (_match, language: string | undefined, code: string) => {
      const lang = language?.trim() ?? '';
      return `\`\`\`${lang}\n${code.trim()}\n\`\`\``;
    })
    .replaceAll(/\{noformat}([\s\S]*?)\{noformat}/g, (_match, content: string) => `\`\`\`\n${content.trim()}\n\`\`\``)
    .replaceAll(/^[ \t]*\*\s+/gm, '- ')
    .replaceAll(/\{\{([^}]+)}}/g, (_match, content: string) => `\`${content}\``);

/**
 * Convert Jira wiki markup patterns embedded in ADF text content into
 * standard markdown so downstream consumers receive clean output.
 *
 * @param text - Raw markdown output from ADF text nodes
 * @returns Markdown with wiki markup patterns normalized
 */
const normalizeWikiMarkupInMarkdown = (text: string): string =>
  text
    .replaceAll(/\{code(?::([^}\n]+))?}([\s\S]*?)\{code}/g, (_match, language: string | undefined, code: string) => {
      const lang = language?.trim() ?? '';
      return `\`\`\`${lang}\n${code.trim()}\n\`\`\``;
    })
    .replaceAll(/\{noformat}([\s\S]*?)\{noformat}/g, (_match, content: string) => `\`\`\`\n${content.trim()}\n\`\`\``)
    .replaceAll(/\{\{([^}]+)}}/g, (_match, content: string) => `\`${content}\``)
    .replaceAll(/^(# .+(?:\n# .+)+)$/gm, block => {
      const items = block.split('\n');
      return items.map((line, i) => `${i + 1}. ${line.replace(/^#\s+/, '')}`).join('\n');
    })
    .replaceAll(/^\*\s+/gm, '- ');

/**
 * Map an HTTP status code to a domain-specific Jira API error.
 *
 * @param status - HTTP response status code
 * @param data - Response body from the Jira REST API
 * @param action - Human-readable description of the failed action
 * @returns JiraApiError with an appropriate message and retryable flag
 */
/**
 * Extract a human-readable error detail from a Jira API response body.
 *
 * @param data - Raw Jira API error response body
 * @returns Concatenated error messages or a fallback string
 */
const extractJiraErrorDetail = (data: Record<string, unknown>): string =>
  (data as { errorMessages?: string[] }).errorMessages?.join(', ')
  || (data as { message?: string }).message
  || 'Unknown error';

const mapStatusToJiraApiError = (status: number, data: Record<string, unknown>, action: string): JiraApiError => {
  switch (status) {
    case 401:
      return new JiraApiError('Authentication failed. Check your Jira email and API token.', { status, data }, false);
    case 403:
      return new JiraApiError('Permission denied. You may not have access to this resource.', { status, data }, false);
    case 404:
      return new JiraApiError(`Resource not found when trying to ${action}`, { status, data }, false);
    default:
      return new JiraApiError(`Jira API error (${status}): ${extractJiraErrorDetail(data)}`, { status, data }, true);
  }
};

/**
 * Build the JQL search payload from a search request, applying defaults.
 *
 * @param request - Jira search request with optional fields and maxResults
 * @returns Payload ready for the Jira search/jql endpoint
 */
/**
 * Build optional Jira create-issue fields from a request and resolved priority.
 *
 * @param request - Create ticket request
 * @param priorityName - Resolved priority name, or null/undefined to omit
 * @returns Partial fields object with only the present optional fields
 */
const assembleOptionalCreateFields = (
  request: CreateTicketRequest,
  priorityName: string | null | undefined
): Record<string, unknown> => {
  const fields: Record<string, unknown> = {};
  if (priorityName) fields.priority = { name: priorityName };
  if (request.labels) fields.labels = request.labels;
  if (request.assignee) fields.assignee = { accountId: request.assignee };
  if (request.components) fields.components = request.components.map(name => ({ name }));
  return fields;
};

const buildSearchPayload = (request: JiraSearchRequest) => ({
  jql: request.jql,
  maxResults: request.maxResults || 50,
  fields: request.fields || [...DEFAULT_SEARCH_FIELDS],
});

/**
 * Check whether a markdown table line is a separator row (e.g. `| --- | --- |`).
 *
 * @param line - Raw markdown table line
 * @returns True when the line is a separator
 */
const isTableSeparator = (line: string): boolean => /^\|[\s:|-]+\|$/.test(line.trim());

/**
 * Parse a markdown table line into an array of trimmed, non-empty cell values.
 *
 * @param line - Raw markdown table line
 * @returns Array of cell text values
 */
const parseTableCells = (line: string): string[] =>
  line.split('|').slice(1, -1).map(c => c.trim()).filter(c => c.length > 0);

/**
 * Map Jira issue field metadata (status, dates, people, labels, components)
 * to domain-level JiraTicket properties.
 *
 * @param fields - Raw Jira fields object
 * @returns Partial JiraTicket with metadata properties
 */
const mapJiraFieldsMetadata = (fields: Record<string, unknown>): Omit<JiraTicket, 'key' | 'id' | 'summary' | 'description'> => ({
  status: (fields.status as { name: string }).name,
  issueType: (fields.issuetype as { name: string }).name,
  priority: (fields.priority as { name?: string })?.name || 'None',
  assignee: (fields.assignee as { displayName?: string })?.displayName,
  reporter: (fields.reporter as { displayName?: string })?.displayName,
  created: new Date(fields.created as string),
  updated: new Date(fields.updated as string),
  labels: (fields.labels as string[]) || [],
  components: (fields.components as Array<{ name: string }>)?.map(c => c.name) || [],
});

/**
 * Apply an ADF mark (strong, em, code, strike, link) to a text string.
 *
 * @param text - Plain text content
 * @param mark - ADF mark with type and optional attrs
 * @returns Text wrapped with the appropriate markdown delimiter
 */
const applyADFMark = (text: string, mark: { type: string; attrs?: Record<string, string> }): string => {
  switch (mark.type) {
    case 'strong': return `**${text}**`;
    case 'em': return `*${text}*`;
    case 'code': return `\`${text}\``;
    case 'strike': return `~~${text}~~`;
    case 'link': return `[${text}](${mark.attrs?.href})`;
    default: return text;
  }
};

/**
 * Parse a markdown header line into an ADF heading node.
 *
 * @param line - Raw markdown line
 * @returns ADF heading node, or undefined when the line is not a header
 */
const parseHeaderBlock = (line: string): Record<string, unknown> | undefined => {
  const match = new RegExp(/^(#{1,6})\s+(.+)$/).exec(line);
  if (!match) return undefined;
  return { type: 'heading', attrs: { level: match[1].length }, content: [{ type: 'text', text: match[2] }] };
};

type InlineScanState = {
  content: ADFTextNode[];
  currentText: string;
  index: number;
};

/**
 * Flush accumulated plain text from the scan state into a text node.
 *
 * @param state - Mutable inline scan state
 */
const flushPlainText = (state: InlineScanState): void => {
  if (!state.currentText) return;
  state.content.push({ type: 'text', text: state.currentText });
  state.currentText = '';
};

type ADFTextNode = {
  type: string;
  text: string;
  marks?: Array<{ type: string }>;
};

/**
 * Extract text between matching delimiters and wrap it in an ADF mark.
 *
 * @param text - Full inline text
 * @param index - Index of the opening delimiter
 * @param delimiter - Delimiter string (e.g. '**', '*', '`')
 * @param markType - ADF mark type name
 * @returns ADF text node with mark and the index after the closing delimiter
 */
const extractDelimited = (
  text: string,
  index: number,
  delimiter: string,
  markType: string
): { node: ADFTextNode; nextIndex: number } => {
  let cursor = index + delimiter.length;
  let span = '';
  while (cursor < text.length && text.substring(cursor, cursor + delimiter.length) !== delimiter) {
    span += text[cursor];
    cursor++;
  }
  return { node: { type: 'text', text: span, marks: [{ type: markType }] }, nextIndex: cursor + delimiter.length };
};

type ListItemMatch = {
  indent: number;
  listType: 'bulletList' | 'orderedList';
  text: string;
};

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
    private readonly configService: ConfigService,
    private readonly httpService: HttpService,
    private readonly logger: LoggerService,
    private readonly issueTrackerConfig: IssueTrackerConfigService
  ) {
    this.loadAtlassianConfig();
  }

  /**
   * Load Atlassian configuration from the config service and warn when
   * credentials are missing for an enabled tracker.
   */
  private loadAtlassianConfig(): void {
    this.baseUrl = this.configService.get<string>('atlassian.baseUrl');
    this.email = this.configService.get<string>('atlassian.email');
    this.apiToken = this.configService.get<string>('atlassian.apiToken');
    this.defaultProject = this.configService.get<string>('atlassian.jira.defaultProject');

    if (this.baseUrl && this.email && this.apiToken) return;

    const hasPartialConfig = Boolean(this.baseUrl || this.email || this.apiToken || this.defaultProject);
    if (this.issueTrackerConfig.isTrackerEnabled('jira', hasPartialConfig)) {
      this.logger.warn(
        'Jira credentials not configured. Set atlassian.baseUrl, atlassian.email, and atlassian.jira.apiToken in wf.config.*.'
      );
    }
  }

  private ensureConfigured(): void {
    if (!this.baseUrl || !this.email || !this.apiToken) {
      throw new JiraApiError(
        'Jira is not configured. Set atlassian.baseUrl, atlassian.email, and atlassian.jira.apiToken in wf.config.*.',
        null,
        false
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
      const response = await firstValueFrom(this.httpService.get(url, { headers: this.getAuthHeaders() }));
      const priorities: Array<{ id: string; name: string }> = response.data;
      const lower = requested.toLowerCase();
      const match = priorities.find(p => p.name.toLowerCase() === lower);
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
    requestedPriority: string
  ): Promise<string | undefined> {
    try {
      return await this.resolveCreatePriorityFromMetadata(projectKey, issueTypeName, requestedPriority);
    } catch {
      return this.resolveValidPriorityName(requestedPriority);
    }
  }

  /**
   * Attempt to resolve a priority using Jira create metadata for the given project and issue type.
   *
   * @param projectKey - Jira project key
   * @param issueTypeName - Jira issue type name
   * @param requestedPriority - Requested priority name
   * @returns Matched priority name, or undefined when unavailable
   */
  private async resolveCreatePriorityFromMetadata(
    projectKey: string,
    issueTypeName: string,
    requestedPriority: string
  ): Promise<string | undefined> {
    const issueTypeId = await this.resolveCreateIssueTypeId(projectKey, issueTypeName);
    if (!issueTypeId) return this.resolveValidPriorityName(requestedPriority);

    const allowedPriorities = await this.fetchCreateAllowedPriorities(projectKey, issueTypeId);
    if (!allowedPriorities) return undefined;

    return this.matchAllowedPriority(requestedPriority, allowedPriorities);
  }

  /**
   * Resolve an issue type name to its Jira ID for create metadata lookups.
   *
   * @param projectKey - Jira project key
   * @param issueTypeName - Jira issue type name to match case-insensitively
   * @returns Jira issue type ID, or undefined when no match is available
   */
  private async resolveCreateIssueTypeId(projectKey: string, issueTypeName: string): Promise<string | undefined> {
    const url = `${this.baseUrl}/rest/api/3/issue/createmeta/${encodeURIComponent(projectKey)}/issuetypes`;
    const response = await firstValueFrom(this.httpService.get(url, { headers: this.getAuthHeaders() }));
    const issueTypes = this.extractCreateIssueTypes(response.data);
    const lowerIssueTypeName = issueTypeName.toLowerCase();
    return issueTypes.find(issueType => issueType.name.toLowerCase() === lowerIssueTypeName)?.id;
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
    issueTypeId: string
  ): Promise<JiraAllowedPriority[] | undefined> {
    const url = `${this.baseUrl}/rest/api/3/issue/createmeta/${encodeURIComponent(
      projectKey
    )}/issuetypes/${encodeURIComponent(issueTypeId)}`;
    const response = await firstValueFrom(this.httpService.get(url, { headers: this.getAuthHeaders() }));
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

    return issueTypes.filter((issueType): issueType is JiraCreateIssueType => {
      if (!issueType || typeof issueType !== 'object') return false;
      const { id, name } = issueType as JiraCreateIssueType;
      return typeof id === 'string' && typeof name === 'string';
    });
  }

  /**
   * Extract the priority field from Jira's create field metadata.
   *
   * @param data - Raw Jira create fields response
   * @returns Priority field metadata, or undefined when absent
   */
  private extractCreatePriorityField(data: unknown): JiraCreateField | undefined {
    const fields = (data as { fields?: unknown })?.fields;
    if (Array.isArray(fields)) {
      return fields.find((field): field is JiraCreateField => this.isPriorityCreateField(field));
    }

    const priorityField = (fields as { priority?: unknown } | undefined)?.priority;
    return this.isCreateFieldWithAllowedValues(priorityField) ? priorityField : undefined;
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
    return fieldKey === 'priority' || createField.name?.toLowerCase() === 'priority';
  }

  /**
   * Check whether a create metadata value is a field with allowed values.
   *
   * @param field - Raw create metadata field
   * @returns True when the field has an allowed values array
   */
  private isCreateFieldWithAllowedValues(field: unknown): field is JiraCreateField {
    return Boolean(field && typeof field === 'object' && Array.isArray((field as JiraCreateField).allowedValues));
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
    allowedPriorities: JiraAllowedPriority[]
  ): string | undefined {
    const lowerRequestedPriority = requestedPriority.toLowerCase();
    const exactMatch = allowedPriorities.find(priority => priority.name.toLowerCase() === lowerRequestedPriority);
    if (exactMatch) {
      return exactMatch.name;
    }

    const aliasNames = PRIORITY_ALIAS_NAMES[lowerRequestedPriority as keyof typeof PRIORITY_ALIAS_NAMES] ?? [];
    const lowerAliasNames = new Set(aliasNames.map((aliasName: string) => aliasName.toLowerCase()));
    return allowedPriorities.find(priority => lowerAliasNames.has(priority.name.toLowerCase()))?.name;
  }

  private getAuthHeaders() {
    const auth = Buffer.from(`${this.email}:${this.apiToken}`).toString('base64');
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
      throw new JiraApiError('No project specified and no default project configured');
    }

    const resolvedPriority = await this.resolveCreateTicketPriority(project, request);

    try {
      return await this.attemptCreateTicket(project, request, resolvedPriority);
    } catch (error) {
      return this.handleCreateTicketError(error, project, request);
    }
  }

  /**
   * Resolve the priority for a create-ticket request against Jira's create metadata.
   *
   * @param project - Jira project key
   * @param request - Create ticket request
   * @returns Resolved priority name, or undefined when unavailable
   */
  private async resolveCreateTicketPriority(
    project: string,
    request: CreateTicketRequest
  ): Promise<string | undefined> {
    if (!request.priority) return undefined;

    const resolved = await this.resolveCreatePriorityName(project, request.issueType || 'Task', request.priority);
    if (!resolved) {
      this.logger.warn(
        `Priority "${request.priority}" is not allowed for ${project} ${request.issueType || 'Task'} creates. Creating ticket without priority.`
      );
    }
    return resolved;
  }

  /**
   * Post a create-issue request to the Jira REST API and return the ticket key.
   *
   * @param project - Jira project key
   * @param request - Create ticket request
   * @param priorityName - Resolved priority name, or undefined to omit
   * @returns Created ticket key
   */
  private async attemptCreateTicket(
    project: string,
    request: CreateTicketRequest,
    priorityName: string | undefined
  ): Promise<string> {
    const payload = this.buildCreatePayload({ ...request, project }, { priorityName: priorityName ?? null });
    const url = `${this.baseUrl}/rest/api/3/issue`;
    const response = await firstValueFrom(this.httpService.post(url, payload, { headers: this.getAuthHeaders() }));
    this.logger.success(`Created Jira ticket: ${response.data.key}`);
    return response.data.key;
  }

  /**
   * Handle a failed create-ticket attempt, retrying without priority when applicable.
   *
   * @param error - Error from the initial create attempt
   * @param project - Jira project key
   * @param request - Original create ticket request
   * @returns Ticket key on successful retry
   */
  private async handleCreateTicketError(
    error: unknown,
    project: string,
    request: CreateTicketRequest
  ): Promise<string> {
    const resp = (error as { response?: { status: number; data: { errors?: { priority?: unknown } } } }).response;
    const isPriorityError = resp?.status === 400 && resp?.data?.errors?.priority;

    if (!isPriorityError) {
      this.handleJiraError(error, 'create ticket');
    }

    this.logger.warn(`Priority rejected by Jira (${request.priority}). Retrying without priority field.`);
    return this.attemptCreateTicket(project, request, undefined);
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
    options: BuildCreatePayloadOptions = {}
  ): { fields: Record<string, unknown> } {
    const project = request.project || this.defaultProject;
    if (!project) throw new JiraApiError('No project specified and no default project configured');

    const priorityName = Object.hasOwn(options, 'priorityName')
      ? options.priorityName
      : request.priority;

    return { fields: this.assembleCreateFields(request, project, priorityName) };
  }

  /**
   * Assemble the fields object for a Jira create-issue payload.
   *
   * @param request - Create ticket request
   * @param project - Resolved Jira project key
   * @param priorityName - Resolved priority name, or null/undefined to omit
   * @returns Jira fields object
   */
  private assembleCreateFields(
    request: CreateTicketRequest,
    project: string,
    priorityName: string | null | undefined
  ): Record<string, unknown> {
    return {
      project: { key: project },
      summary: stripInlineMarkdownDelimiters(request.summary),
      description: this.markdownToADF(request.description),
      issuetype: { name: request.issueType || 'Task' },
      ...assembleOptionalCreateFields(request, priorityName),
    };
  }

  /**
   * Build the Jira update payload without performing any network calls.
   *
   * @param updates - Partial Jira update request mapped to Jira field names
   * @returns Jira REST API payload for issue updates
   */
  buildUpdatePayload(updates: UpdateTicketRequest): { fields: Record<string, unknown> } {
    const fields: Record<string, unknown> = {};

    if (updates.summary) fields.summary = stripInlineMarkdownDelimiters(updates.summary);
    if (updates.description) fields.description = this.markdownToADF(updates.description);
    if (updates.priority) fields.priority = { name: updates.priority };
    if (updates.labels) fields.labels = updates.labels;
    if (updates.assignee) fields.assignee = { accountId: updates.assignee };

    return { fields };
  }

  async getTicket(ticketKey: string): Promise<JiraTicket> {
    this.ensureConfigured();

    try {
      const url = `${this.baseUrl}/rest/api/3/issue/${ticketKey}`;
      const response = await firstValueFrom(this.httpService.get(url, { headers: this.getAuthHeaders() }));
      this.validateJiraResponse(response.data);
      return this.mapJiraFieldsToTicket(response.data);
    } catch (error) {
      this.handleJiraError(error, `get ticket ${ticketKey}`);
    }
  }

  /**
   * Validate that a Jira API response has the expected structure.
   *
   * @param data - Raw response data from the Jira REST API
   */
  private validateJiraResponse(data: Record<string, unknown>): void {
    if (data?.fields) return;
    this.logger.error('Invalid response from Jira API', JSON.stringify(data));
    throw new JiraApiError('Invalid response structure from Jira API');
  }

  /**
   * Map raw Jira issue data to a domain JiraTicket.
   *
   * @param data - Raw Jira issue response with key, id, and fields
   * @returns Mapped JiraTicket domain object
   */
  private mapJiraFieldsToTicket(data: Record<string, unknown>): JiraTicket {
    const fields = (data as { fields: Record<string, unknown> }).fields;
    return {
      key: data.key as string,
      id: data.id as string,
      summary: fields.summary as string,
      description: this.adfToMarkdown(fields.description),
      ...mapJiraFieldsMetadata(fields),
    };
  }

  async updateTicket(ticketKey: string, updates: UpdateTicketRequest): Promise<void> {
    this.ensureConfigured();

    try {
      const payload = this.buildUpdatePayload(updates);
      const url = `${this.baseUrl}/rest/api/3/issue/${ticketKey}`;
      await firstValueFrom(this.httpService.put(url, payload, { headers: this.getAuthHeaders() }));

      this.logger.success(`Updated Jira ticket: ${ticketKey}`);
    } catch (error) {
      this.handleJiraError(error, `update ticket ${ticketKey}`);
    }
  }

  async searchTickets(request: JiraSearchRequest): Promise<JiraTicket[]> {
    this.ensureConfigured();

    try {
      const url = `${this.baseUrl}/rest/api/3/search/jql`;
      const payload = buildSearchPayload(request);
      const response = await firstValueFrom(this.httpService.post(url, payload, { headers: this.getAuthHeaders() }));
      return response.data.issues.map((issue: Record<string, unknown>) => this.mapIssueToTicket(issue));
    } catch (error) {
      this.handleJiraError(error, 'search tickets');
    }
  }

  /**
   * Map a raw Jira search-result issue to a domain JiraTicket.
   *
   * @param issue - Raw Jira issue object from a search response
   * @returns Mapped JiraTicket domain object
   */
  private mapIssueToTicket(issue: Record<string, unknown>): JiraTicket {
    return this.mapJiraFieldsToTicket(issue);
  }

  markdownToADF(markdown: string): Record<string, unknown> {
    if (!markdown) return { type: 'doc', version: 1, content: [] };
    const lines = normalizeMarkdownForADF(markdown).split('\n');
    const content = this.parseADFBlocks(lines);
    return { type: 'doc', version: 1, content };
  }

  /**
   * Parse all non-blank markdown lines into an array of ADF block nodes.
   *
   * @param lines - Markdown lines to parse
   * @returns Array of ADF block nodes
   */
  private parseADFBlocks(lines: string[]): Array<Record<string, unknown>> {
    const content: Array<Record<string, unknown>> = [];
    let i = 0;
    while (i < lines.length) {
      if (!lines[i].trim()) {
        i++;
        continue;
      }
      const result = this.parseADFBlock(lines, i);
      content.push(result.node);
      i = result.nextIndex;
    }
    return content;
  }

  /**
   * Parse a single ADF block element from markdown lines starting at the given index.
   *
   * @param lines - Full markdown split by lines
   * @param index - Current line index
   * @returns Parsed ADF block node and the next unread line index
   */
  private parseADFBlock(
    lines: string[],
    index: number
  ): { node: Record<string, unknown>; nextIndex: number } {
    const line = lines[index];

    const header = parseHeaderBlock(line);
    if (header) return { node: header, nextIndex: index + 1 };

    if (line.startsWith('```')) return this.parseCodeBlock(lines, index);

    const listItemMatch = this.matchListItem(line);
    if (listItemMatch) return this.parseList(lines, index, listItemMatch);

    if (line.trimStart().startsWith('|') && line.trimEnd().endsWith('|')) {
      return this.parseTableBlock(lines, index);
    }

    return { node: { type: 'paragraph', content: this.parseInlineMarkdown(line) }, nextIndex: index + 1 };
  }

  /**
   * Parse a fenced code block starting at the opening fence line.
   *
   * @param lines - Full markdown split by lines
   * @param index - Index of the opening fence line
   * @returns ADF codeBlock node and the index after the closing fence
   */
  private parseCodeBlock(lines: string[], index: number): { node: Record<string, unknown>; nextIndex: number } {
    const lang = lines[index].substring(3).trim();
    const codeLines: string[] = [];
    let cursor = index + 1;
    while (cursor < lines.length && !lines[cursor].startsWith('```')) {
      codeLines.push(lines[cursor]);
      cursor++;
    }
    const attrs = lang ? { language: lang } : {};
    const node = { type: 'codeBlock', attrs, content: [{ type: 'text', text: codeLines.join('\n') }] };
    return { node, nextIndex: cursor + 1 };
  }

  /**
   * Parse a markdown table block and degrade it to an ADF bullet list.
   *
   * @param lines - Full markdown split by lines
   * @param index - Index of the first table line
   * @returns ADF bulletList node and the index after the last table line
   */
  private parseTableBlock(lines: string[], index: number): { node: Record<string, unknown>; nextIndex: number } {
    const tableLines: string[] = [];
    let cursor = index;
    while (cursor < lines.length && lines[cursor].trimStart().startsWith('|') && lines[cursor].trimEnd().endsWith('|')) {
      tableLines.push(lines[cursor]);
      cursor++;
    }

    const listItems = this.buildTableListItems(tableLines);
    const node = listItems.length > 0
      ? { type: 'bulletList', content: listItems }
      : { type: 'paragraph', content: [{ type: 'text', text: '' }] };

    return { node, nextIndex: cursor };
  }

  /**
   * Convert parsed markdown table lines into ADF list items.
   *
   * @param tableLines - Raw markdown table lines
   * @returns Array of ADF listItem nodes
   */
  private buildTableListItems(tableLines: string[]): Array<Record<string, unknown>> {
    const headerCells = parseTableCells(tableLines[0]);
    const dataRows = tableLines.slice(1).filter(l => !isTableSeparator(l));

    const makeItem = (text: string) => ({
      type: 'listItem',
      content: [{ type: 'paragraph', content: this.parseInlineMarkdown(text) }],
    });

    if (dataRows.length === 0) return headerCells.map(cell => makeItem(cell));

    return dataRows.map(row => {
      const cells = parseTableCells(row);
      return makeItem(headerCells.map((h, idx) => (cells[idx] ? `${h}: ${cells[idx]}` : null)).filter(Boolean).join(' | '));
    });
  }

  /**
   * Match a markdown list item and capture its indentation, type, and text.
   *
   * @param line - Raw markdown line
   * @returns Parsed list item metadata when the line is a list item
   */
  private matchListItem(line: string): ListItemMatch | undefined {
    const bulletMatch = new RegExp(/^(\s*)[-*]\s+(.+)$/).exec(line);
    if (bulletMatch) return { indent: bulletMatch[1].length, listType: 'bulletList', text: bulletMatch[2] };

    const orderedMatch = new RegExp(/^(\s*)\d+\.\s+(.+)$/).exec(line);
    if (orderedMatch) return { indent: orderedMatch[1].length, listType: 'orderedList', text: orderedMatch[2] };

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
    lines: string[], startIndex: number, rootMatch: ListItemMatch
  ): { node: Record<string, unknown>; nextIndex: number } {
    const { items, nextIndex } = this.collectListItems(lines, startIndex, rootMatch);
    return { node: { type: rootMatch.listType, content: items }, nextIndex };
  }

  /**
   * Collect list items at the same indent level and list type.
   *
   * @param lines - Full markdown lines
   * @param startIndex - First list-item line index
   * @param rootMatch - Root-level list match for comparison
   * @returns Collected list items and the next unread line index
   */
  private collectListItems(
    lines: string[], startIndex: number, rootMatch: ListItemMatch
  ): { items: Array<Record<string, unknown>>; nextIndex: number } {
    const items: Array<Record<string, unknown>> = [];
    let index = startIndex;
    while (index < lines.length) {
      const next = this.advanceListItem(lines, index, rootMatch, items);
      if (next === undefined) break;
      index = next;
    }
    return { items, nextIndex: index };
  }

  /**
   * Advance a single step in list item collection.
   *
   * @param lines - Full markdown lines
   * @param index - Current line index
   * @param rootMatch - Root-level list match
   * @param items - Mutable items array to append to
   * @returns Next index to continue from, or undefined to break
   */
  private advanceListItem(
    lines: string[], index: number, rootMatch: ListItemMatch,
    items: Array<Record<string, unknown>>
  ): number | undefined {
    const resolved = this.resolveListLine(lines, index, rootMatch);
    if (resolved.action === 'break') return undefined;
    if (resolved.action === 'skip') return resolved.nextIndex;
    const parsed = this.parseListItem(lines, index + 1, rootMatch, resolved.match);
    items.push(parsed.item);
    return parsed.nextIndex;
  }

  /**
   * Determine the action for the current line during list parsing.
   *
   * @param lines - Full markdown lines
   * @param index - Current line index
   * @param rootMatch - Root-level list match for comparison
   * @returns Action directive: 'skip' with nextIndex, 'break', or 'match' with the matched item
   */
  private resolveListLine(
    lines: string[], index: number, rootMatch: ListItemMatch
  ): { action: 'skip'; nextIndex: number } | { action: 'break' } | { action: 'match'; match: ListItemMatch } {
    const match = this.matchListItem(lines[index]);
    if (!match) {
      const resumed = this.skipBlankLinesIf(
        lines, index, m => m.indent === rootMatch.indent && m.listType === rootMatch.listType
      );
      return resumed == null ? { action: 'break' } : { action: 'skip', nextIndex: resumed };
    }
    if (match.indent < rootMatch.indent) return { action: 'break' };
    if (match.indent > rootMatch.indent || match.listType !== rootMatch.listType) return { action: 'break' };
    return { action: 'match', match };
  }

  /**
   * Parse a single list item and any nested children beneath it.
   *
   * @param lines - Full markdown split by lines
   * @param startIndex - Index after the current item's own line
   * @param rootMatch - Root-level list match for indent comparison
   * @param itemMatch - Parsed metadata for the current list item
   * @returns Parsed list item node and the next unread line index
   */
  private parseListItem(
    lines: string[],
    startIndex: number,
    rootMatch: ListItemMatch,
    itemMatch: ListItemMatch
  ): { item: Record<string, unknown>; nextIndex: number } {
    const itemContent: Array<Record<string, unknown>> = [
      { type: 'paragraph', content: this.parseInlineMarkdown(itemMatch.text) },
    ];
    const nextIndex = this.collectNestedLists(lines, startIndex, rootMatch, itemContent);
    return { item: { type: 'listItem', content: itemContent }, nextIndex };
  }

  /**
   * Collect nested list nodes beneath a list item and append them to the item content.
   *
   * @param lines - Full markdown lines
   * @param startIndex - Index to start scanning for nested items
   * @param rootMatch - Root-level list match for indent comparison
   * @param itemContent - Mutable content array to append nested lists to
   * @returns Index after all nested content has been consumed
   */
  private collectNestedLists(
    lines: string[], startIndex: number, rootMatch: ListItemMatch,
    itemContent: Array<Record<string, unknown>>
  ): number {
    let index = startIndex;
    while (index < lines.length) {
      const next = this.advanceNestedList(lines, index, rootMatch, itemContent);
      if (next === undefined) break;
      index = next;
    }
    return index;
  }

  /**
   * Advance a single step in nested list collection.
   *
   * @param lines - Full markdown lines
   * @param index - Current line index
   * @param rootMatch - Parent-level list match
   * @param itemContent - Mutable content array
   * @returns Next index to continue from, or undefined to break
   */
  private advanceNestedList(
    lines: string[], index: number, rootMatch: ListItemMatch,
    itemContent: Array<Record<string, unknown>>
  ): number | undefined {
    const resolved = this.resolveNestedLine(lines, index, rootMatch);
    if (resolved.action === 'break') return undefined;
    if (resolved.action === 'skip') return resolved.nextIndex;
    const nestedList = this.parseList(lines, index, resolved.match);
    itemContent.push(nestedList.node);
    return nestedList.nextIndex;
  }

  /**
   * Determine the action for the current line during nested list scanning.
   *
   * @param lines - Full markdown lines
   * @param index - Current line index
   * @param rootMatch - Parent-level list match for indent comparison
   * @returns Action directive for the nested scan loop
   */
  private resolveNestedLine(
    lines: string[],
    index: number,
    rootMatch: ListItemMatch
  ): { action: 'skip'; nextIndex: number } | { action: 'break' } | { action: 'match'; match: ListItemMatch } {
    const nested = this.matchListItem(lines[index]);
    if (!nested) {
      const resumed = this.skipBlankLinesIf(lines, index, m => m.indent > rootMatch.indent);
      return resumed == null ? { action: 'break' } : { action: 'skip', nextIndex: resumed };
    }
    return nested.indent <= rootMatch.indent ? { action: 'break' } : { action: 'match', match: nested };
  }

  /**
   * Skip past consecutive blank lines and return the index of the next
   * non-blank line if it satisfies `predicate`, otherwise return `undefined`.
   */
  private skipBlankLinesIf(
    lines: string[],
    fromIndex: number,
    predicate: (match: ListItemMatch) => boolean
  ): number | undefined {
    if (lines[fromIndex].trim()) return undefined;

    let lookAhead = fromIndex + 1;
    while (lookAhead < lines.length && !lines[lookAhead].trim()) {
      lookAhead++;
    }

    if (lookAhead >= lines.length) return undefined;

    const nextMatch = this.matchListItem(lines[lookAhead]);
    if (nextMatch && predicate(nextMatch)) return lookAhead;

    return undefined;
  }

  private parseInlineMarkdown(text: string): ADFTextNode[] {
    const result = this.scanInlineTokens(text);
    return result.length > 0 ? result : [{ type: 'text', text: '' }];
  }

  /**
   * Scan inline text for delimited spans and plain text segments.
   *
   * @param text - Full inline text to tokenize
   * @returns Array of ADF text nodes
   */
  private scanInlineTokens(text: string): ADFTextNode[] {
    const state: InlineScanState = { content: [], currentText: '', index: 0 };
    while (state.index < text.length) {
      this.advanceInlineToken(text, state);
    }
    flushPlainText(state);
    return state.content;
  }

  /**
   * Advance a single step in inline text scanning, either consuming a
   * delimited span or appending the current character to the plain text buffer.
   *
   * @param text - Full inline text
   * @param state - Mutable scan state
   */
  private advanceInlineToken(text: string, state: InlineScanState): void {
    const span = this.parseDelimitedSpan(text, state.index);
    if (!span) {
      state.currentText += text[state.index];
      state.index++;
      return;
    }
    flushPlainText(state);
    state.content.push(span.node);
    state.index = span.nextIndex;
  }

  /**
   * Parse a delimited inline span (bold, italic, or code) starting at the given index.
   *
   * @param text - Full inline text being parsed
   * @param index - Current character index
   * @returns Parsed ADF text node and next index, or undefined when no delimiter matches
   */
  private parseDelimitedSpan(text: string, index: number): { node: ADFTextNode; nextIndex: number } | undefined {
    if (text.substring(index, index + 2) === '**') return extractDelimited(text, index, '**', 'strong');
    if (text[index] === '*' && text[index + 1] !== '*') return extractDelimited(text, index, '*', 'em');
    if (text[index] === '`') return extractDelimited(text, index, '`', 'code');
    return undefined;
  }

  adfToMarkdown(adf: any): string {
    if (!adf?.content) return '';

    const raw = adf.content.map((node: any) => this.processADFNode(node)).join('');

    return normalizeWikiMarkupInMarkdown(raw);
  }

  private processADFNode(node: Record<string, unknown>): string {
    return this.processADFBlockNode(node) ?? this.processADFInlineNode(node);
  }

  /**
   * Process block-level ADF nodes (paragraph, heading, list, code, blockquote, etc.).
   *
   * @param node - ADF node
   * @returns Markdown string, or undefined when the node is not a block type
   */
  private processADFBlockNode(node: Record<string, unknown>): string | undefined {
    return this.processADFStructuralNode(node) ?? this.processADFContainerNode(node);
  }

  /**
   * Process structural ADF block nodes (paragraph, heading, list, code, etc.).
   *
   * @param node - ADF node
   * @returns Markdown string, or undefined when the node type is not structural
   */
  private processADFStructuralNode(node: Record<string, unknown>): string | undefined {
    const content = () => this.processADFContent(node.content as Array<Record<string, unknown>>);
    switch (node.type) {
      case 'paragraph': return content() + '\n\n';
      case 'heading': return this.processADFHeading(node);
      case 'bulletList': return this.processADFList(node, () => '- ');
      case 'orderedList': return this.processADFList(node, (_item, i) => `${i + 1}. `);
      case 'codeBlock': return this.processADFCodeBlock(node);
      case 'listItem': return content();
      case 'hardBreak': return '\n';
      case 'blockquote': return this.processADFBlockquote(node);
      default: return undefined;
    }
  }

  /**
   * Process container and decorative ADF nodes (table, expand, panel, rule, media).
   *
   * @param node - ADF node
   * @returns Markdown string, or undefined when the node type is not a container
   */
  private processADFContainerNode(node: Record<string, unknown>): string | undefined {
    switch (node.type) {
      case 'rule': return '---\n\n';
      case 'table': return this.processADFTable(node) + '\n\n';
      case 'expand': case 'nestedExpand': return this.processADFExpand(node);
      case 'panel': return this.processADFChildren(node);
      case 'mediaSingle': case 'mediaGroup': return '[media]\n\n';
      default: return undefined;
    }
  }

  /**
   * Process inline and metadata ADF nodes (inlineCard, mention, emoji, status, date).
   *
   * @param node - ADF node
   * @returns Markdown string
   */
  private processADFInlineNode(node: Record<string, unknown>): string {
    const attrs = node.attrs as Record<string, string> | undefined;
    switch (node.type) {
      case 'inlineCard': return attrs?.url || '[card]';
      case 'mention': return attrs?.text || '@unknown';
      case 'emoji': return attrs?.shortName || attrs?.text || '';
      case 'status': return attrs?.text || '';
      case 'date': return this.processADFDate(node);
      default: return this.processADFContent((node.content || []) as Array<Record<string, unknown>>);
    }
  }

  /**
   * Process an ADF heading node into markdown.
   *
   * @param node - ADF heading node
   * @returns Markdown heading string
   */
  private processADFHeading(node: Record<string, unknown>): string {
    const level = '#'.repeat((node.attrs as { level: number }).level);
    return `${level} ${this.processADFContent(node.content as Array<Record<string, unknown>>)}\n\n`;
  }

  /**
   * Process an ADF list node (bullet or ordered) into markdown.
   *
   * @param node - ADF list node
   * @param prefixFn - Function returning the line prefix for each item
   * @returns Markdown list string
   */
  private processADFList(
    node: Record<string, unknown>,
    prefixFn: (item: Record<string, unknown>, index: number) => string
  ): string {
    const items = node.content as Array<Record<string, unknown>>;
    return items.map((item, i) => {
      const text = this.processADFContent(item.content as Array<Record<string, unknown>>).trim();
      return `${prefixFn(item, i)}${text}`;
    }).join('\n') + '\n\n';
  }

  /**
   * Process an ADF codeBlock node into a fenced markdown code block.
   *
   * @param node - ADF codeBlock node
   * @returns Markdown fenced code block string
   */
  private processADFCodeBlock(node: Record<string, unknown>): string {
    const lang = (node.attrs as Record<string, string>)?.language || '';
    return `\`\`\`${lang}\n${this.processADFContent(node.content as Array<Record<string, unknown>>)}\n\`\`\`\n\n`;
  }

  /**
   * Process an ADF blockquote node into markdown.
   *
   * @param node - ADF blockquote node
   * @returns Markdown blockquote string
   */
  private processADFBlockquote(node: Record<string, unknown>): string {
    const children = (node.content || []) as Array<Record<string, unknown>>;
    return children.map(child =>
      this.processADFNode(child).replace(/\n+$/, '').split('\n').map(line => `> ${line}`).join('\n')
    ).join('\n') + '\n\n';
  }

  /**
   * Process an ADF expand/nestedExpand node into markdown.
   *
   * @param node - ADF expand node
   * @returns Markdown string with optional bold title
   */
  private processADFExpand(node: Record<string, unknown>): string {
    const title = (node.attrs as Record<string, string>)?.title;
    const body = this.processADFChildren(node);
    return title ? `**${title}**\n\n${body}` : body;
  }

  /**
   * Process all children of an ADF container node.
   *
   * @param node - ADF container node with content array
   * @returns Concatenated markdown from all child nodes
   */
  private processADFChildren(node: Record<string, unknown>): string {
    return ((node.content || []) as Array<Record<string, unknown>>).map(child => this.processADFNode(child)).join('');
  }

  /**
   * Process an ADF date node into an ISO date string.
   *
   * @param node - ADF date node
   * @returns ISO date string or empty string
   */
  private processADFDate(node: Record<string, unknown>): string {
    const timestamp = (node.attrs as Record<string, string>)?.timestamp;
    return timestamp ? new Date(Number(timestamp)).toISOString().split('T')[0] : '';
  }

  private processADFTable(node: Record<string, unknown>): string {
    const rows: string[] = [];
    for (const row of (node.content || []) as Array<Record<string, unknown>>) {
      const cells = ((row.content || []) as Array<Record<string, unknown>>)
        .map(cell => this.processADFContent(cell.content as Array<Record<string, unknown>>).trim());
      rows.push(`| ${cells.join(' | ')} |`);
      if (rows.length === 1) {
        rows.push(`| ${cells.map(() => '---').join(' | ')} |`);
      }
    }
    return rows.join('\n');
  }

  private processADFContent(content: Array<Record<string, unknown>>): string {
    if (!content) return '';

    return content.map(node => {
      if (node.type !== 'text') return this.processADFNode(node);
      return this.processADFTextNode(node);
    }).join('');
  }

  /**
   * Process an ADF text node, applying any marks (bold, italic, code, etc.).
   *
   * @param node - ADF text node with optional marks array
   * @returns Markdown-formatted text
   */
  private processADFTextNode(node: Record<string, unknown>): string {
    let text = node.text as string;
    const marks = node.marks as Array<{ type: string; attrs?: Record<string, string> }> | undefined;
    if (!marks) return text;

    for (const mark of marks) {
      text = applyADFMark(text, mark);
    }
    return text;
  }

  private handleJiraError(error: unknown, action: string): never {
    this.logger.error(`Failed to ${action}`, (error as Error)?.stack);
    const response = (error as { response?: { status: number; data: Record<string, unknown> } }).response;

    if (!response) {
      throw new JiraApiError(`Failed to ${action}: ${(error as Error).message}`, error, true);
    }

    throw mapStatusToJiraApiError(response.status, response.data, action);
  }
}
