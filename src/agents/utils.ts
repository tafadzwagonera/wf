// src/agents/utils.ts

/**
 * Extract the ticket summary from a markdown ticket file.
 * Matches: "# TICKET-123: Summary text"
 */
export const extractSummary = (content: string): string => {
  const match = content.match(/^#\s+[A-Z]+-\d+:\s+(.+)$/m);
  return match ? match[1] : 'Implementation';
};

/**
 * Convert a string to a URL-safe slug (max 50 chars).
 */
export const slugify = (text: string): string =>
  text
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .substring(0, 50);
