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

/**
 * Headings whose content is stripped from ticket descriptions before
 * creation or update. These sections are either internal provenance
 * (References), redundant with CLI options (Affected Repositories), or
 * implementation-level detail better suited to the plan artifact
 * (Unit Test Scope, Dependencies).
 */
const STRIPPED_SECTIONS = ['#### References', '### Unit Test Scope', '#### Dependencies', '### Affected Repositories'];

/**
 * Remove ticket-template sections that should not appear on the tracker.
 * Each heading and every line beneath it up to the next heading of any
 * level (1-4) is removed.
 *
 * @param description - Markdown ticket description
 * @returns Description with stripped sections removed
 */
export const stripRedundantSections = (description: string): string => {
  let result = description;
  for (const heading of STRIPPED_SECTIONS) {
    const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(`${escaped}\\n(?:(?!#{1,4}\\s).*\\n?)*`, 'g');
    result = result.replace(pattern, '');
  }
  return result;
};
