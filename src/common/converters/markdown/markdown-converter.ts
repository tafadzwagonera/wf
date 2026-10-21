import { Injectable } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { FormatConverter } from '../format-converter.interface';
import { UniversalTicket, TicketType, TicketPriority } from '../../dto/universal-ticket.dto';
import { stripInlineMarkdownDelimiters } from '../../utils/markdown-text';
import { AppError, WorkflowParseError } from '../../utils/errors';

const SYNTHETIC_TITLE_LABEL_PATTERN = /^(?:title|heading)\s*:\s*(.+)$/i;

const normalizeMarkdownTitle = (title: string): string => {
  const match = SYNTHETIC_TITLE_LABEL_PATTERN.exec(title.trim());
  return stripInlineMarkdownDelimiters(match?.[1] ?? title);
};

const setListField = (data: Partial<UniversalTicket>, value: string, key: 'labels' | 'components'): void => {
  if (value && value !== 'None') data[key] = value.split(',').map(v => v.trim());
};

const metadataFieldSetters: Record<string, (data: Partial<UniversalTicket>, value: string) => void> = {
  type: (data, value) => { data.type = value.toLowerCase() as TicketType; },
  status: (data, value) => { data.status = value; },
  priority: (data, value) => { data.priority = value.toLowerCase() as TicketPriority; },
  assignee: (data, value) => { if (value && value !== 'Unassigned') data.assignee = value; },
  reporter: (data, value) => { if (value && value !== 'Unknown') data.reporter = value; },
  project: (data, value) => { data.project = value; },
  labels: (data, value) => setListField(data, value, 'labels'),
  components: (data, value) => setListField(data, value, 'components'),
  created: (data, value) => { data.created = new Date(value); },
  updated: (data, value) => { data.updated = new Date(value); },
};

@Injectable()
export class MarkdownConverter implements FormatConverter {
  parse(content: string): UniversalTicket {
    try {
      const ticket = plainToInstance(UniversalTicket, this.parseTicketData(content));
      this.assertValid(ticket);
      return ticket;
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new WorkflowParseError(`Invalid Markdown format: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private parseTicketData(content: string): Partial<UniversalTicket> {
    const lines = content.split('\n');
    const data: Partial<UniversalTicket> = { ...this.parseTitleAndKey(lines) };
    const descriptionIndex = lines.findIndex(l => /^##\s+Description$/i.exec(l.trim()));
    const headerLines = descriptionIndex >= 0 ? lines.slice(0, descriptionIndex) : lines;
    for (const line of headerLines) this.applyMetadataField(line, data);
    if (!data.title) throw new WorkflowParseError('Markdown must contain a title');
    data.description = this.parseDescription(lines) || '';
    return data;
  }

  private parseTitleAndKey(lines: string[]): Pick<Partial<UniversalTicket>, 'key' | 'title'> {
    const titleLine = lines.find(l => l.trim().startsWith('#'));
    if (!titleLine) return {};
    const titleMatch = /^#\s+(?:\[([^\]]+)\]:\s*)?(.+)$/.exec(titleLine);
    if (!titleMatch) return {};
    return {
      key: titleMatch[1] ? titleMatch[1].trim() : undefined,
      title: normalizeMarkdownTitle(titleMatch[2]),
    };
  }

  private parseDescription(lines: string[]): string | undefined {
    const descriptionIndex = lines.findIndex(l => /^##\s+Description$/i.exec(l.trim()));
    if (descriptionIndex === -1) return undefined;
    return lines.slice(descriptionIndex + 1).join('\n').trim();
  }

  private assertValid(ticket: UniversalTicket): void {
    const errors = validateSync(ticket);
    if (errors.length > 0) {
      const messages = errors.map(e => Object.values(e.constraints || {}));
      throw new WorkflowParseError(`Validation failed: ${messages.join(', ')}`);
    }
  }

  serialize(ticket: UniversalTicket): string {
    const titleLine = ticket.key ? `# [${ticket.key}]: ${ticket.title}` : `# ${ticket.title}`;
    return [
      titleLine,
      '',
      ...this.buildMetadataLines(ticket),
      '',
      '## Description',
      '',
      ticket.description,
    ].join('\n');
  }

  private buildMetadataLines(ticket: UniversalTicket): string[] {
    const formatDate = (value: Date | string): string => (value instanceof Date ? value.toLocaleDateString() : value);
    const lines: string[] = [];
    if (ticket.type) lines.push(`**Type:** ${ticket.type}`);
    if (ticket.status) lines.push(`**Status:** ${ticket.status}`);
    if (ticket.priority) lines.push(`**Priority:** ${ticket.priority}`);
    if (ticket.assignee) lines.push(`**Assignee:** ${ticket.assignee}`);
    if (ticket.reporter) lines.push(`**Reporter:** ${ticket.reporter}`);
    if (ticket.project) lines.push(`**Project:** ${ticket.project}`);
    if (ticket.created) lines.push(`**Created:** ${formatDate(ticket.created)}`);
    if (ticket.updated) lines.push(`**Updated:** ${formatDate(ticket.updated)}`);
    if (ticket.labels && ticket.labels.length > 0) lines.push(`**Labels:** ${ticket.labels.join(', ')}`);
    if (ticket.components && ticket.components.length > 0) lines.push(`**Components:** ${ticket.components.join(', ')}`);
    return lines;
  }

  getFormatName(): string {
    return 'md';
  }

  validate(content: string): boolean {
    try {
      const hasTitle = /^#\s+/m.exec(content.trim());
      return !!hasTitle;
    } catch {
      return false;
    }
  }

  getFileExtension(): string {
    return '.md';
  }

  private applyMetadataField(line: string, data: Partial<UniversalTicket>): void {
    const metadataMatch = /^\*\*([^:]+):\*\*\s*(.+)$/.exec(line);
    if (!metadataMatch) return;

    const field = metadataMatch[1].trim().toLowerCase();
    const value = metadataMatch[2].trim();
    metadataFieldSetters[field]?.(data, value);
  }
}
