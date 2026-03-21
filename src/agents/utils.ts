// src/agents/utils.ts

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
