// src/agents/utils.ts
import * as path from 'path';

/**
 * Resolve the artifact storage directory for a given platform.
 *
 * @param baseDir - Base directory for artifact storage
 * @param platformName - The platform name (e.g. 'jira', 'bitbucket')
 * @returns Absolute path to the platform artifact directory under `.wf/`
 */
export const resolveArtifactDir = (
  baseDir: string,
  platformName: string,
): string => path.join(baseDir, '.wf', platformName);

/**
 * Extract the ticket summary from a markdown ticket file.
 * Matches headings of the form: "# TICKET-123: Summary text"
 *
 * @param content - Raw markdown content of the ticket file
 * @returns The summary text, or 'Implementation' if no match found
 */
export const extractSummary = (content: string): string => {
  const match = content.match(/^#\s+[A-Z]+-\d+:\s+(.+)$/m);
  return match ? match[1] : 'Implementation';
};

/**
 * Convert a string to a URL-safe slug (max 50 chars).
 * Lowercases, strips non-word characters, collapses spaces to hyphens,
 * deduplicates hyphens, strips leading/trailing hyphens, then truncates.
 *
 * @param text - Input string to slugify
 * @returns URL-safe slug of at most 50 characters
 */
export const slugify = (text: string): string =>
  text
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .substring(0, 50);
