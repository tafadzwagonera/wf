import { Injectable } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { FormatConverter } from '../format-converter.interface';
import {
  UniversalTicket,
  TicketType,
  TicketPriority,
} from '../../dto/universal-ticket.dto';
import { stripInlineMarkdownDelimiters } from '../../utils/markdown-text';

const SYNTHETIC_TITLE_LABEL_PATTERN = /^(?:title|heading)\s*:\s*(.+)$/i;

/**
 * Remove known synthetic title labels added by generated markdown artifacts.
 *
 * @param title - Raw title text extracted from the markdown heading
 * @returns Normalized title suitable for downstream ticket creation
 */
const normalizeMarkdownTitle = (title: string): string => {
  const match = title.trim().match(SYNTHETIC_TITLE_LABEL_PATTERN);
  return stripInlineMarkdownDelimiters(match?.[1] ?? title);
};

/**
 * Markdown format converter for UniversalTicket
 * Handles parsing and serialization of tickets in Markdown format
 */
@Injectable()
export class MarkdownConverter implements FormatConverter {
  /**
   * Parse Markdown content into a UniversalTicket
   * Expected format:
   * # [KEY]: Title
   * **Type:** task
   * **Status:** todo
   * ... metadata fields ...
   * ## Description
   * Description content here
   */
  parse(content: string): UniversalTicket {
    try {
      const lines = content.split('\n');
      const data: Partial<UniversalTicket> = {};

      // Parse title and key from first line (# [KEY]: Title or # Title)
      const titleLine = lines.find((l) => l.trim().startsWith('#'));
      if (titleLine) {
        const titleMatch = titleLine.match(/^#\s+(?:\[([^\]]+)\]:\s*)?(.+)$/);
        if (titleMatch) {
          if (titleMatch[1]) {
            data.key = titleMatch[1].trim();
          }
          data.title = normalizeMarkdownTitle(titleMatch[2]);
        }
      }

      // Parse metadata fields
      for (const line of lines) {
        const metadataMatch = line.match(/^\*\*([^:]+):\*\*\s*(.+)$/);
        if (metadataMatch) {
          const field = metadataMatch[1].trim();
          const value = metadataMatch[2].trim();

          switch (field.toLowerCase()) {
            case 'type':
              data.type = value.toLowerCase() as TicketType;
              break;
            case 'status':
              data.status = value;
              break;
            case 'priority':
              data.priority = value.toLowerCase() as TicketPriority;
              break;
            case 'assignee':
              if (value && value !== 'Unassigned') {
                data.assignee = value;
              }
              break;
            case 'reporter':
              if (value && value !== 'Unknown') {
                data.reporter = value;
              }
              break;
            case 'project':
              data.project = value;
              break;
            case 'labels':
              if (value && value !== 'None') {
                data.labels = value.split(',').map((l) => l.trim());
              }
              break;
            case 'components':
              if (value && value !== 'None') {
                data.components = value.split(',').map((c) => c.trim());
              }
              break;
            case 'created':
              data.created = new Date(value);
              break;
            case 'updated':
              data.updated = new Date(value);
              break;
          }
        }
      }

      // Parse description section
      const descriptionIndex = lines.findIndex((l) =>
        l.trim().match(/^##\s+Description$/i),
      );
      if (descriptionIndex !== -1) {
        const descriptionLines = lines.slice(descriptionIndex + 1);
        data.description = descriptionLines.join('\n').trim();
      }

      // Validate required fields
      if (!data.title) {
        throw new Error('Markdown must contain a title');
      }
      if (!data.description) {
        data.description = ''; // Allow empty description
      }

      const ticket = plainToInstance(UniversalTicket, data);

      // Validate the ticket
      const errors = validateSync(ticket);
      if (errors.length > 0) {
        const messages = errors.map((e) => Object.values(e.constraints || {}));
        throw new Error(`Validation failed: ${messages.join(', ')}`);
      }

      return ticket;
    } catch (error) {
      if (error.message && error.message.includes('Validation failed')) {
        throw error;
      }
      throw new Error(`Invalid Markdown format: ${error.message}`);
    }
  }

  /**
   * Serialize a UniversalTicket into Markdown format
   */
  serialize(ticket: UniversalTicket): string {
    const lines: string[] = [];

    // Title with optional key
    if (ticket.key) {
      lines.push(`# [${ticket.key}]: ${ticket.title}`);
    } else {
      lines.push(`# ${ticket.title}`);
    }
    lines.push('');

    // Metadata fields
    if (ticket.type) {
      lines.push(`**Type:** ${ticket.type}`);
    }
    if (ticket.status) {
      lines.push(`**Status:** ${ticket.status}`);
    }
    if (ticket.priority) {
      lines.push(`**Priority:** ${ticket.priority}`);
    }
    if (ticket.assignee) {
      lines.push(`**Assignee:** ${ticket.assignee}`);
    }
    if (ticket.reporter) {
      lines.push(`**Reporter:** ${ticket.reporter}`);
    }
    if (ticket.project) {
      lines.push(`**Project:** ${ticket.project}`);
    }
    if (ticket.created) {
      lines.push(
        `**Created:** ${ticket.created instanceof Date ? ticket.created.toLocaleDateString() : ticket.created}`,
      );
    }
    if (ticket.updated) {
      lines.push(
        `**Updated:** ${ticket.updated instanceof Date ? ticket.updated.toLocaleDateString() : ticket.updated}`,
      );
    }
    if (ticket.labels && ticket.labels.length > 0) {
      lines.push(`**Labels:** ${ticket.labels.join(', ')}`);
    }
    if (ticket.components && ticket.components.length > 0) {
      lines.push(`**Components:** ${ticket.components.join(', ')}`);
    }

    lines.push('');

    // Description section
    lines.push('## Description');
    lines.push('');
    lines.push(ticket.description);

    return lines.join('\n');
  }

  /**
   * Get the format name
   */
  getFormatName(): string {
    return 'md';
  }

  /**
   * Validate if content looks like valid Markdown
   * (Basic check - Markdown is flexible so we just check for some structure)
   */
  validate(content: string): boolean {
    try {
      // Check if content has at least a title (starts with #)
      const hasTitle = content.trim().match(/^#\s+/m);
      return !!hasTitle;
    } catch {
      return false;
    }
  }

  /**
   * Get the file extension
   */
  getFileExtension(): string {
    return '.md';
  }
}
