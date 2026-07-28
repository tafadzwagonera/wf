/**
 * Manual Test: ADF ordered-list coalescing and table-to-bulletList degradation
 *
 * Run:
 *   nr test:manual -- test-adf-list-and-table-smoke
 *
 * Verifies two fixes in JiraService.markdownToADF():
 * 1. Ordered/bullet list items separated by blank lines produce a single list node
 * 2. Markdown tables degrade to bulletList nodes instead of raw paragraph text
 */

import assert from 'node:assert';
import { JiraService } from '../../src/integrations/jira/jira.service';

interface AdfNode {
  type?: string;
  text?: string;
  content?: AdfNode[];
  [key: string]: unknown;
}

const collectNodes = (node: unknown): AdfNode[] => {
  if (!node || typeof node !== 'object') return [];
  if (Array.isArray(node)) return node.flatMap(collectNodes);
  const obj = node as AdfNode;
  return [obj, ...Object.values(obj).flatMap(v => collectNodes(v))];
};

const extractText = (node: AdfNode): string =>
  collectNodes(node)
    .filter(n => n.type === 'text' && typeof n.text === 'string')
    .map(n => n.text ?? '')
    .join('');

const createService = (): JiraService =>
  new JiraService(
    { get: () => undefined } as any,
    { put: () => undefined } as any,
    { warn: () => undefined, success: () => undefined } as any,
    { isTrackerEnabled: () => true } as any
  );

const main = (): void => {
  const service = createService();
  let failures = 0;

  const check = (label: string, fn: () => void): void => {
    try {
      fn();
      console.log(`  PASS: ${label}`);
    } catch (error: any) {
      failures += 1;
      console.log(`  FAIL: ${label}`);
      console.log(`        ${error.message}`);
    }
  };

  console.log('\nManual Test: ADF list coalescing and table degradation\n');

  check('ordered list items separated by blank lines produce a single orderedList', () => {
    const adf = service.markdownToADF('1. First item\n\n2. Second item\n\n3. Third item');
    const topLevel = (adf as AdfNode).content ?? [];
    assert.strictEqual(topLevel.length, 1, `Expected 1 top-level node, got ${topLevel.length}`);
    assert.strictEqual(topLevel[0].type, 'orderedList');
    assert.strictEqual(topLevel[0]?.content?.length, 3, `Expected 3 listItems, got ${topLevel[0]?.content?.length}`);
  });

  check('bullet list items separated by blank lines produce a single bulletList', () => {
    const adf = service.markdownToADF('- Alpha\n\n- Beta\n\n- Gamma');
    const topLevel = (adf as AdfNode).content ?? [];
    assert.strictEqual(topLevel.length, 1, `Expected 1 top-level node, got ${topLevel.length}`);
    assert.strictEqual(topLevel[0].type, 'bulletList');
    assert.strictEqual(topLevel[0]?.content?.length, 3, `Expected 3 listItems, got ${topLevel[0]?.content?.length}`);
  });

  check('mixed list types separated by blank line produce separate lists', () => {
    const adf = service.markdownToADF('1. Ordered\n\n- Bullet');
    const topLevel = (adf as AdfNode).content ?? [];
    assert.strictEqual(topLevel.length, 2, `Expected 2 top-level nodes, got ${topLevel.length}`);
    assert.strictEqual(topLevel[0].type, 'orderedList');
    assert.strictEqual(topLevel[1].type, 'bulletList');
  });

  check('multiple consecutive blank lines between ordered items still coalesce', () => {
    const adf = service.markdownToADF('1. A\n\n\n\n2. B');
    const topLevel = (adf as AdfNode).content ?? [];
    assert.strictEqual(topLevel.length, 1, `Expected 1 top-level node, got ${topLevel.length}`);
    assert.strictEqual(topLevel[0].type, 'orderedList');
    assert.strictEqual(topLevel[0]?.content?.length, 2);
  });

  check('markdown table with header and data rows degrades to bulletList', () => {
    const md = '| ID | Name |\n|---|---|\n| 1 | Alice |\n| 2 | Bob |';
    const adf = service.markdownToADF(md);
    const topLevel = (adf as AdfNode).content ?? [];
    assert.strictEqual(topLevel.length, 1, `Expected 1 top-level node, got ${topLevel.length}`);
    assert.strictEqual(topLevel[0].type, 'bulletList');
    assert.strictEqual(topLevel[0]?.content?.length, 2, `Expected 2 listItems, got ${topLevel[0]?.content?.length}`);
    const firstItem = topLevel[0]?.content?.[0];
    const firstText = firstItem ? extractText(firstItem) : '';
    assert(firstText.includes('ID: 1'), `Expected "ID: 1" in first item, got "${firstText}"`);
    assert(firstText.includes('Name: Alice'), `Expected "Name: Alice" in first item, got "${firstText}"`);
  });

  check('header-only table degrades to bulletList of header cells', () => {
    const md = '| Foo | Bar | Baz |';
    const adf = service.markdownToADF(md);
    const topLevel = (adf as AdfNode).content ?? [];
    assert.strictEqual(topLevel.length, 1);
    assert.strictEqual(topLevel[0].type, 'bulletList');
    assert.strictEqual(topLevel[0]?.content?.length, 3);
  });

  check('table without separator row still degrades gracefully', () => {
    const md = '| H1 | H2 |\n| v1 | v2 |';
    const adf = service.markdownToADF(md);
    const topLevel = (adf as AdfNode).content ?? [];
    assert.strictEqual(topLevel.length, 1);
    assert.strictEqual(topLevel[0].type, 'bulletList');
    // Without separator, row 2 is treated as data
    assert((topLevel[0]?.content?.length ?? 0) >= 1);
  });

  check('no paragraph nodes contain raw pipe table syntax', () => {
    const md = '# Title\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\nSome text';
    const adf = service.markdownToADF(md);
    const paragraphs = collectNodes(adf).filter(n => n.type === 'paragraph');
    for (const p of paragraphs) {
      const text = extractText(p);
      // Only flag if text looks like a full table row: starts and ends with |
      const looksLikeTableRow = text.trim().startsWith('|') && text.trim().endsWith('|');
      assert(!looksLikeTableRow, `Paragraph contains raw table syntax: "${text}"`);
    }
  });

  console.log('');
  if (failures > 0) {
    console.log(`FAIL: ${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log('PASS: All checks passed.');
};

main();
