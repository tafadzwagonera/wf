/**
 * Strip lightweight inline Markdown delimiters when text is destined for
 * plain-text platform fields such as Jira summaries.
 *
 * @param text - Text that may contain inline Markdown delimiters
 * @returns Text with common inline formatting delimiters removed
 */
export const stripInlineMarkdownDelimiters = (text: string): string =>
  text
    .replace(/`([^`\n]+)`/g, '$1')
    .replace(/\*\*([^*\n]+)\*\*/g, '$1')
    .replace(/\*([^*\n]+)\*/g, '$1')
    .trim();
