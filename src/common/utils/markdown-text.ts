/**
 * Strip lightweight inline Markdown delimiters when text is destined for
 * plain-text platform fields such as Jira summaries.
 *
 * @param text - Text that may contain inline Markdown delimiters
 * @returns Text with common inline formatting delimiters removed
 */
export const stripInlineMarkdownDelimiters = (text: string): string =>
  text
    .replaceAll(/`([^`\n]+)`/g, '$1')
    .replaceAll(/\*\*([^*\n]+)\*\*/g, '$1')
    .replaceAll(/\*([^*\n]+)\*/g, '$1')
    .trim();

/**
 * Headings whose content is stripped from ticket descriptions before
 * creation or update. These sections are either internal provenance
 * (References), redundant with CLI options (Affected Repositories),
 * implementation-level detail better suited to the plan artifact
 * (Unit Test Scope, Dependencies).
 */
const STRIPPED_SECTIONS = [
  '#### References',
  '### Unit Test Scope',
  '#### Dependencies',
  '### Affected Repositories',
];

interface StripRedundantSectionsResult {
  description: string;
  strippedHeadings: string[];
}

/**
 * Remove ticket-template sections that should not appear on the tracker.
 * Each heading and every line beneath it up to the next heading of any
 * level (1-4) is removed.
 *
 * @param description - Markdown ticket description
 * @returns Description with stripped sections removed
 */
export const stripRedundantSections = (description: string): string => {
  return stripRedundantSectionsWithReport(description).description;
};

/**
 * Remove ticket-template sections and report which headings were removed.
 *
 * @param description - Markdown ticket description
 * @returns Sanitized description plus removed heading names
 */
export const stripRedundantSectionsWithReport = (description: string): StripRedundantSectionsResult => {
  return STRIPPED_SECTIONS.reduce<StripRedundantSectionsResult>((result, heading) => {
    const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(`${escaped}\\n(?:(?!#{1,4}\\s).*\\n?)*`, 'g');
    const descriptionWithoutHeading = result.description.replace(pattern, '');
    return descriptionWithoutHeading === result.description
      ? result
      : {
          description: descriptionWithoutHeading,
          strippedHeadings: [...result.strippedHeadings, heading],
        };
  }, { description, strippedHeadings: [] });
};
