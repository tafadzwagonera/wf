import * as fs from 'fs';
import * as path from 'path';
import { JsonConverter } from '../../common/converters/json/json-converter';
import { MarkdownConverter } from '../../common/converters/markdown/markdown-converter';
import { YamlConverter } from '../../common/converters/yaml/yaml-converter';
import type { UniversalTicket } from '../../common/dto/universal-ticket.dto';
import { getWfHomeDir } from './wf-paths';
import type { PriorTicketSummary, PriorTicketContext } from '../types/detection.types';
import { collectWfArtifactFiles } from './collect-wf-artifact-files';

export type { PriorTicketSummary, PriorTicketContext };

export const FILE_PATH_REGEX = /[\w-/]+(?:\.[\w-]+)+/g;
export const COMPONENT_NAME_REGEX = /\b[A-Z][a-zA-Z]+(?:Service|Controller|Module|Agent|Command|Guard|Interceptor)\b/g;
export const ERROR_PATTERN_REGEX = /\b(?:Error|Exception|ENOENT|ECONNREFUSED|timeout|deadlock|race condition)\b/gi;

const SUMMARY_MAX_CHARS = 500;
const DEFAULT_LIMIT = 10;
const FORMAT_MAX_TICKETS = 5;
const FORMAT_MAX_CHARS = 3000;
const TICKET_ARTIFACT_PATTERN = /-ticket-description\.(json|md|yaml|yml)$/i;

const jsonConverter = new JsonConverter();
const markdownConverter = new MarkdownConverter();
const yamlConverter = new YamlConverter();

/**
 * Extract keywords from title + summary text.
 * Pulls file paths, component names, and error patterns; deduplicates results.
 *
 * @param title - Ticket title text
 * @param summary - Ticket summary text
 * @returns Deduplicated array of keyword strings
 */
export const extractTicketKeywords = (title: string, summary: string): string[] => {
  const combined = `${title} ${summary}`;

  const filePaths = combined.match(FILE_PATH_REGEX) ?? [];
  const componentNames = combined.match(COMPONENT_NAME_REGEX) ?? [];
  const errorPatterns = combined.match(ERROR_PATTERN_REGEX) ?? [];

  const all = [...filePaths, ...componentNames, ...errorPatterns];
  return [...new Set(all)];
};

const buildPriorTicketSummary = (
  ticket: Pick<UniversalTicket, 'title' | 'description' | 'key'>,
  filename: string
): PriorTicketSummary => {
  const summary = ticket.description.trim().slice(0, SUMMARY_MAX_CHARS);
  const keywords = extractTicketKeywords(ticket.title, summary);

  return {
    title: ticket.title,
    summary,
    filename,
    keywords,
    ticketKey: ticket.key,
  };
};

const parseLegacyMarkdownTicket = (raw: string, filename: string): PriorTicketSummary | null => {
  const titleMatch = raw.match(/^#\s+(.+)/m);
  const title = titleMatch ? titleMatch[1].trim() : '';

  if (!title) {
    return null;
  }

  const summaryMatch = raw.match(/###\s+Summary\s*\n([\s\S]*?)(?=\n###|\s*$)/);
  const summaryRaw = summaryMatch ? summaryMatch[1].trim() : '';
  const summary = summaryRaw.slice(0, SUMMARY_MAX_CHARS);
  const keywords = extractTicketKeywords(title, summary);

  return {
    title,
    summary,
    filename,
    keywords,
  };
};

const parseStructuredTicket = (raw: string, extension: string): UniversalTicket | null => {
  try {
    switch (extension) {
      case 'json':
        return jsonConverter.parse(raw);
      case 'yaml':
      case 'yml':
        return yamlConverter.parse(raw);
      case 'md':
        return markdownConverter.parse(raw);
      default:
        return null;
    }
  } catch {
    return null;
  }
};

const parsePriorTicketArtifact = (raw: string, filePath: string): PriorTicketSummary | null => {
  const filename = path.basename(filePath);
  const extension = path.extname(filePath).slice(1).toLowerCase();
  const structuredTicket = parseStructuredTicket(raw, extension);

  if (extension === 'md') {
    const legacyTicket = parseLegacyMarkdownTicket(raw, filename);

    if (structuredTicket?.description.trim()) {
      return buildPriorTicketSummary(structuredTicket, filename);
    }

    if (legacyTicket) {
      return legacyTicket;
    }
  }

  if (structuredTicket) {
    return buildPriorTicketSummary(structuredTicket, filename);
  }

  return null;
};

/**
 * Detect prior ticket artifacts from anywhere under ~/.wf/<repoName>/.
 *
 * @param repoName - The repository name to look up under the wf home directory
 * @param opts - Optional configuration
 * @param opts.limit - Maximum number of tickets to return (default 10)
 * @returns A PriorTicketContext with found tickets; never throws
 */
export const detectPriorTickets = (repoName: string, opts?: { limit?: number }): PriorTicketContext => {
  const limit = opts?.limit ?? DEFAULT_LIMIT;
  const repoDir = path.join(getWfHomeDir(), repoName);

  if (!fs.existsSync(repoDir)) {
    return { tickets: [], repoName };
  }

  const ticketPaths = collectWfArtifactFiles(repoDir, (_filePath, fileName) => TICKET_ARTIFACT_PATTERN.test(fileName));
  const ticketFiles: Array<{ filePath: string; mtime: number }> = [];

  for (const filePath of ticketPaths) {
    try {
      const stat = fs.statSync(filePath);
      ticketFiles.push({ filePath, mtime: stat.mtimeMs });
    } catch {
      // skip unreadable stat
    }
  }

  ticketFiles.sort((a, b) => b.mtime - a.mtime);

  const limited = ticketFiles.slice(0, limit);

  const tickets: PriorTicketSummary[] = [];

  for (const { filePath } of limited) {
    try {
      const raw = fs.readFileSync(filePath, 'utf-8');
      const ticket = parsePriorTicketArtifact(raw, filePath);

      if (!ticket) {
        continue;
      }

      tickets.push(ticket);
    } catch {
      // skip unreadable file
    }
  }

  return { tickets, repoName };
};

/**
 * Format a PriorTicketContext into a prompt section string.
 * Caps output at 5 tickets and ~3000 chars total.
 *
 * @param ctx - The prior ticket context
 * @returns Formatted prompt section string, or empty string when tickets is empty
 */
export const formatPriorTicketsPromptSection = (ctx: PriorTicketContext): string => {
  if (ctx.tickets.length === 0) return '';

  const capped = ctx.tickets.slice(0, FORMAT_MAX_TICKETS);
  const lines: string[] = [`Related prior tickets (${ctx.repoName}):`];

  for (const ticket of capped) {
    const keywordStr = ticket.keywords.join(', ');
    const line = `- ${ticket.title}: ${ticket.summary}${keywordStr ? ` (keywords: ${keywordStr})` : ''}`;
    lines.push(line);
  }

  const result = lines.join('\n');
  return result.slice(0, FORMAT_MAX_CHARS);
};
