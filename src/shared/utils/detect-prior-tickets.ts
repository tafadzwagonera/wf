import * as fs from 'fs';
import * as path from 'path';
import { getWfHomeDir } from './wf-paths';
import type { PriorTicketSummary, PriorTicketContext } from '../types/detection.types';

export type { PriorTicketSummary, PriorTicketContext };

export const FILE_PATH_REGEX = /[\w-/]+(?:\.[\w-]+)+/g;
export const COMPONENT_NAME_REGEX = /\b[A-Z][a-zA-Z]+(?:Service|Controller|Module|Agent|Command|Guard|Interceptor)\b/g;
export const ERROR_PATTERN_REGEX = /\b(?:Error|Exception|ENOENT|ECONNREFUSED|timeout|deadlock|race condition)\b/gi;

const SUMMARY_MAX_CHARS = 500;
const DEFAULT_LIMIT = 10;
const FORMAT_MAX_TICKETS = 5;
const FORMAT_MAX_CHARS = 3000;

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

/**
 * Detect prior ticket artifacts from ~/.wf/<repoName>/ tracker subdirectories.
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

  const ticketFiles: Array<{ filePath: string; mtime: number }> = [];

  try {
    const trackerEntries = fs.readdirSync(repoDir, { withFileTypes: true });

    for (const trackerEntry of trackerEntries) {
      if (!trackerEntry.isDirectory()) continue;

      const trackerDir = path.join(repoDir, trackerEntry.name);

      try {
        const fileEntries = fs.readdirSync(trackerDir);

        for (const fileName of fileEntries) {
          if (!fileName.endsWith('-ticket-description.md') && !fileName.endsWith('.md')) {
            continue;
          }

          const filePath = path.join(trackerDir, fileName);

          try {
            const stat = fs.statSync(filePath);
            ticketFiles.push({ filePath, mtime: stat.mtimeMs });
          } catch {
            // skip unreadable stat
          }
        }
      } catch {
        // skip unreadable tracker dir
      }
    }
  } catch {
    return { tickets: [], repoName };
  }

  ticketFiles.sort((a, b) => b.mtime - a.mtime);

  const limited = ticketFiles.slice(0, limit);

  const tickets: PriorTicketSummary[] = [];

  for (const { filePath } of limited) {
    try {
      const raw = fs.readFileSync(filePath, 'utf-8');

      const titleMatch = raw.match(/^#\s+(.+)/m);
      const title = titleMatch ? titleMatch[1].trim() : '';

      const summaryMatch = raw.match(/###\s+Summary\s*\n([\s\S]*?)(?=\n###|\s*$)/);
      const summaryRaw = summaryMatch ? summaryMatch[1].trim() : '';
      const summary = summaryRaw.slice(0, SUMMARY_MAX_CHARS);

      const keywords = extractTicketKeywords(title, summary);

      tickets.push({
        title,
        summary,
        filename: path.basename(filePath),
        keywords,
      });
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
