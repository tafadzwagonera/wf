/**
 * Shared wiki markup test fixtures for both the write path
 * (normalizeMarkdownForADF) and read path (normalizeWikiMarkupInMarkdown).
 *
 * Each fixture describes a wiki markup pattern, the raw input for each path,
 * and separate expected-output assertions for each path: the write path
 * produces ADF JSON (checked via JSON.stringify), while the read path
 * produces markdown text.
 *
 * Round-trip tests also draw from this corpus.
 */

export interface WikiMarkupFixture {
  /** Human-readable label for the test case. */
  label: string;
  /** Raw markdown input for the write path (markdownToADF). */
  writeInput: string;
  /** Substrings that MUST appear in the ADF JSON output (write path). */
  writeExpectContains: string[];
  /** Substrings that MUST NOT appear in the ADF JSON output (write path). */
  writeExpectNotContains: string[];
  /** Raw text content as it appears inside an ADF text node (read path). */
  readInput: string;
  /** Substrings that MUST appear in the markdown output (read path). */
  readExpectContains: string[];
  /** Substrings that MUST NOT appear in the markdown output (read path). */
  readExpectNotContains: string[];
}

export const WIKI_MARKUP_FIXTURES: WikiMarkupFixture[] = [
  {
    label: '{code:lang} block with language',
    writeInput: '{code:css}\n.a4-page {\n  display: block;\n}\n{code}',
    writeExpectContains: ['codeBlock', '"language":"css"', '.a4-page'],
    writeExpectNotContains: ['{code'],
    readInput: '{code:css}@media print {\n.a4-page {\ndisplay: block;\n}\n}{code}',
    readExpectContains: ['```css', '```'],
    readExpectNotContains: ['{code:css}', '{code}'],
  },
  {
    label: '{code} block without language',
    writeInput: '{code}\nraw content here\n{code}',
    writeExpectContains: ['codeBlock', 'raw content here'],
    writeExpectNotContains: ['{code}'],
    readInput: '{code}raw content here{code}',
    readExpectContains: ['```', 'raw content here'],
    readExpectNotContains: ['{code}'],
  },
  {
    label: '{noformat} block',
    writeInput: '{noformat}\nsome raw output\n{noformat}',
    writeExpectContains: ['codeBlock'],
    writeExpectNotContains: ['{noformat}'],
    readInput: '{noformat}italic text → rendered as italic{noformat}',
    readExpectContains: ['```'],
    readExpectNotContains: ['{noformat}'],
  },
  {
    label: '{{monospace}} inline code',
    writeInput: 'The {{bufferPx}} variable controls spacing.',
    writeExpectContains: ['code'],
    writeExpectNotContains: ['{{', '}}'],
    readInput: 'The {{bufferPx}} variable controls spacing.',
    readExpectContains: ['`bufferPx`'],
    readExpectNotContains: ['{{bufferPx}}'],
  },
  {
    label: 'consecutive # ordered list items',
    writeInput: '# Open the editor\n# Export to PDF\n# Observe the output',
    writeExpectContains: ['orderedList', 'Open the editor', 'Export to PDF', 'Observe the output'],
    writeExpectNotContains: [],
    readInput: '# Open the editor\n# Export to PDF\n# Observe the output',
    readExpectContains: ['1. ', '2. ', '3. '],
    readExpectNotContains: [],
  },
  {
    label: '* bullet list items',
    writeInput: '* Introduce a utility.\n* The normalizer must operate.',
    writeExpectContains: ['bulletList', 'Introduce a utility.', 'The normalizer must operate.'],
    writeExpectNotContains: [],
    readInput: '* Introduce a utility.\n* The normalizer must operate.',
    readExpectContains: ['- Introduce a utility.', '- The normalizer must operate.'],
    readExpectNotContains: [],
  },
  {
    label: 'indented {code:lang} block',
    writeInput: '  {code:css}\n  .a4-page { display: block; }\n  {code}',
    writeExpectContains: ['codeBlock', '"language":"css"', '.a4-page'],
    writeExpectNotContains: ['{code'],
    readInput: '{code:css}.a4-page { display: block; }{code}',
    readExpectContains: ['```css', '.a4-page'],
    readExpectNotContains: ['{code'],
  },
  {
    label: 'indented {noformat} block',
    writeInput: '  {noformat}\n  raw output\n  {noformat}',
    writeExpectContains: ['codeBlock'],
    writeExpectNotContains: ['{noformat}'],
    readInput: '{noformat}raw output{noformat}',
    readExpectContains: ['```'],
    readExpectNotContains: ['{noformat}'],
  },
];

export interface ProseReferenceFixture {
  /** Human-readable label for the test case. */
  label: string;
  /** Mid-line prose input that must NOT be converted on the write path. */
  writeInput: string;
  /** Substring that must be preserved as literal text. */
  expectPreserved: string;
}

export const PROSE_REFERENCE_FIXTURES: ProseReferenceFixture[] = [
  {
    label: 'mid-line {code:lang}...{code} reference in prose',
    writeInput: 'Specifically, {code:lang}...{code} blocks should not be converted inline.',
    expectPreserved: '{code:lang}',
  },
  {
    label: 'mid-line {noformat}...{noformat} reference in prose',
    writeInput: 'The {noformat}...{noformat} pattern should not be converted inline.',
    expectPreserved: '{noformat}',
  },
];
