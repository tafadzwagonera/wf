const UI_PATH_PATTERN = /\.(vue|tsx|jsx)\b|\/(?:components|pages|layouts)\//;
const UI_WORD_PATTERN
  = /\b(?:component|page|style|css|classes?|layout|responsive|spacing|padding|margin|typography|colou?r|button|header|footer|hero|card|modal|icon|accessib\w*|aria|design|visual|breakpoint|viewport)\b/i;

/**
 * Returns true when ticket text references frontend file paths, extensions, or
 * UI-vocabulary keywords — used to gate design-system prompt sections.
 */
export const isUiRelevantTicket = (content: string): boolean =>
  UI_PATH_PATTERN.test(content) || UI_WORD_PATTERN.test(content);
