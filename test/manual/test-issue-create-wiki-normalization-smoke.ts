/**
 * Manual Test: issue:create --dry-run skips mid-line {code:lang} and {noformat} prose references
 *
 * Run: nr test:manual -- test-issue-create-wiki-normalization-smoke
 *
 * Spins up the full NestJS application context and exercises the write path
 * (markdownToADF via JiraAdapter.buildCreatePayload) with a ticket description
 * containing both real block-level wiki markers and mid-line prose references.
 * Block-level markers must produce codeBlock ADF nodes; mid-line references
 * must pass through as literal text in paragraph nodes.
 */

import assert from 'assert';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../../src/app.module';
import { JiraAdapter } from '../../src/integrations/issue-trackers/jira/jira-adapter';
import { UniversalTicket } from '../../src/common/dto/universal-ticket.dto';

const DESCRIPTION = [
  '### Summary',
  '',
  'The {code:lang}...{code} and {noformat}...{noformat} patterns must be',
  'converted before the ADF parser processes them.',
  '',
  '#### Technical Details',
  '',
  'The {{bufferPx}} variable controls page-break spacing.',
  '',
  '{code:css}@media print {',
  '.a4-page { display: block; }',
  '}{code}',
  '',
  '{noformat}FAIL src/renderer.spec.ts',
  '  Expected: "avoid"',
  '  Received: undefined{noformat}',
].join('\n');

interface AdfNode {
  type: string;
  attrs?: Record<string, unknown>;
  text?: string;
  content?: AdfNode[];
  marks?: Array<{ type: string }>;
}

const collectNodes = (root: AdfNode, type: string): AdfNode[] => {
  const found: AdfNode[] = [];
  const walk = (node: AdfNode): void => {
    if (node.type === type) found.push(node);
    for (const child of node.content ?? []) walk(child);
  };
  walk(root);
  return found;
};

const collectTextNodes = (root: AdfNode): string[] => {
  const texts: string[] = [];
  const walk = (node: AdfNode): void => {
    if (node.type === 'text' && typeof node.text === 'string') texts.push(node.text);
    for (const child of node.content ?? []) walk(child);
  };
  walk(root);
  return texts;
};

async function main() {
  console.log('\nManual Test: issue:create wiki normalization (write path, app-level)\n');

  const app = await NestFactory.createApplicationContext(AppModule, { logger: false });

  try {
    const adapter = app.get(JiraAdapter);
    const ticket = new UniversalTicket({
      title: 'Test wiki normalization',
      description: DESCRIPTION,
      project: 'TEST',
    });
    const payload = adapter.buildCreatePayload(ticket);
    const adf = payload.fields.description as AdfNode;

    // 1. Exactly 2 codeBlock nodes (css block + noformat block)
    const codeBlocks = collectNodes(adf, 'codeBlock');
    assert.strictEqual(codeBlocks.length, 2, `expected 2 codeBlock nodes, got ${codeBlocks.length}`);
    console.log('  PASS: exactly 2 codeBlock nodes produced');

    // 2. First codeBlock has language "css"
    assert.strictEqual(
      (codeBlocks[0].attrs as { language?: string })?.language,
      'css',
      `expected language "css", got "${(codeBlocks[0].attrs as { language?: string })?.language}"`
    );
    console.log('  PASS: first codeBlock has language "css"');

    // 3. Second codeBlock has no language (noformat)
    const secondLang = (codeBlocks[1].attrs as { language?: string })?.language;
    assert(!secondLang, `expected no language for noformat block, got "${secondLang}"`);
    console.log('  PASS: second codeBlock has no language (noformat)');

    // 4. Mid-line {code:lang} reference preserved as literal text
    const textNodes = collectTextNodes(adf);
    const hasLiteralCodeRef = textNodes.some(t => t.includes('{code:lang}'));
    assert(hasLiteralCodeRef, 'mid-line {code:lang} reference was not preserved as literal text');
    console.log('  PASS: mid-line {code:lang} preserved as literal text');

    // 5. Mid-line {noformat} reference preserved as literal text
    const hasLiteralNoformatRef = textNodes.some(t => t.includes('{noformat}'));
    assert(hasLiteralNoformatRef, 'mid-line {noformat} reference was not preserved as literal text');
    console.log('  PASS: mid-line {noformat} preserved as literal text');

    // 6. No codeBlock has a garbled language containing prose fragments
    for (const block of codeBlocks) {
      const lang = (block.attrs as { language?: string })?.language ?? '';
      assert(
        !lang.includes('blocks') && !lang.includes('patterns'),
        `codeBlock has garbled language: "${lang}"`
      );
    }
    console.log('  PASS: no codeBlock has garbled language from prose');

    // 7. {{bufferPx}} converted to inline code mark
    const hasInlineCode = textNodes.includes('bufferPx');
    assert(hasInlineCode, '{{bufferPx}} was not converted to inline code');
    console.log('  PASS: {{bufferPx}} converted to inline code mark');

    console.log('\nAll write-path wiki normalization smoke tests passed.\n');
  } finally {
    await app.close();
  }
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
