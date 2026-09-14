/**
 * Manual smoke test: extractFigmaLinks strips trailing string-literal delimiters
 * from URLs embedded in code snippets.
 *
 * Run: nr test:manual -- figma-link-extraction-code-snippet-context.smoke
 */

import { extractFigmaLinks } from '../../src/shared/utils/extract-figma-links';
import { createReporter } from './support/reporter';

const { counts, pass, fail } = createReporter();

function assertSingleCleanLink(label: string, input: string, expected: string): void {
  const result = extractFigmaLinks(input);
  const link = result[0];
  if (result.length === 1 && link === expected && !/['"[\]>]$/.test(link)) {
    pass(`${label}: ${link}`);
  } else if (result.length !== 1) {
    fail(`${label}: expected 1 link, got ${result.length}`, JSON.stringify(result));
  } else if (link !== expected) {
    fail(`${label}: wrong URL`, `got ${link}`);
  } else {
    fail(`${label}: trailing delimiter in result`, link);
  }
}

function main(): void {
  console.log('Manual smoke: extractFigmaLinks strips trailing string-literal delimiters\n');

  const expected = 'https://figma.com/design/X/Page?node-id=1-1';

  assertSingleCleanLink(
    'single-quoted array element (trailing apostrophe)',
    "mockReturnValue(['https://figma.com/design/X/Page?node-id=1-1',",
    expected,
  );

  assertSingleCleanLink(
    'double-quoted object value (trailing double-quote)',
    'url: "https://figma.com/design/X/Page?node-id=1-1"',
    expected,
  );

  assertSingleCleanLink(
    "single-quoted array literal (trailing '])",
    "figmaLinks: ['https://figma.com/design/X/Page?node-id=1-1']",
    expected,
  );

  assertSingleCleanLink(
    'plain prose URL (no change expected)',
    'See https://figma.com/design/abc/Page?node-id=1-2 for reference.',
    'https://figma.com/design/abc/Page?node-id=1-2',
  );

  const allLinks = [
    extractFigmaLinks("mockReturnValue(['https://figma.com/design/X/Page?node-id=1-1',"),
    extractFigmaLinks('url: "https://figma.com/design/X/Page?node-id=1-1"'),
    extractFigmaLinks("figmaLinks: ['https://figma.com/design/X/Page?node-id=1-1']"),
    extractFigmaLinks('See https://figma.com/design/abc/Page?node-id=1-2 for reference.'),
  ].flat();

  const withTrailing = allLinks.filter(u => /['"[\]>]$/.test(u));
  if (withTrailing.length === 0) {
    pass('No returned URL carries trailing string-literal delimiters');
  } else {
    fail('Trailing delimiters found in extracted URLs', JSON.stringify(withTrailing));
  }

  console.log(`\n${counts.passed} passed, ${counts.failed} failed`);
  if (counts.failed > 0) process.exit(1);
  console.log('\nManual smoke test passed: extractFigmaLinks strips code-snippet delimiters');
}

main();
