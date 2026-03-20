/**
 * Build a representative 10-line markdown content preview for a ticket artifact
 * @param ticketKey Ticket identifier used to fill template placeholders
 * @returns Preview string (10 lines)
 */
export const buildTicketMarkdownPreview = (ticketKey: string): string =>
  [
    '# <title>',
    '',
    `**Ticket:** ${ticketKey}`,
    '**Type:** <type>',
    '**Status:** <status>',
    '**Priority:** <priority>',
    '**Assignee:** <assignee>',
    '',
    '## Description',
    '<description>',
  ].join('\n');
