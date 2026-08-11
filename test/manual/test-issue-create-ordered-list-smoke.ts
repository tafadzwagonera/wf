/**
 * Manual Test: issue:create --dry-run converts consecutive # items to orderedList
 *
 * Run: nr test:manual -- test-issue-create-ordered-list-smoke
 *
 * Spins up the full NestJS application context and exercises the write path
 * (markdownToADF via JiraAdapter.buildCreatePayload) with a ticket description
 * containing consecutive Jira wiki-style # ordered-list items. These must
 * produce an orderedList ADF node, not level-1 heading nodes. A single # line
 * must still be parsed as a heading.
 */

import assert from 'assert';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../../src/app.module';
import { JiraAdapter } from '../../src/integrations/issue-trackers/jira/jira-adapter';
import { UniversalTicket } from '../../src/common/dto/universal-ticket.dto';

const DESCRIPTION = [
  '### Steps to Reproduce',
  '',
  '# Open the editor',
  '# Navigate to the settings panel',
  '# Toggle the feature flag and save',
  '',
  '### Expected Behaviour',
  '',
  'All three steps execute without error.',
].join('\n');

interface AdfNode {
  type: string;
  attrs?: Record<string, unknown>;
  text?: string;
  content?: AdfNode[];
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
  console.log('\nManual Test: issue:create ordered list normalization (write path, app-level)\n');

  const app = await NestFactory.createApplicationContext(AppModule, { logger: false });

  try {
    const adapter = app.get(JiraAdapter);
    const ticket = new UniversalTicket({
      title: 'Test ordered list normalization',
      description: DESCRIPTION,
      project: 'TEST',
    });
    const payload = adapter.buildCreatePayload(ticket);
    const adf = payload.fields.description as AdfNode;

    // 1. Exactly 1 orderedList node with 3 listItem children
    const orderedLists = collectNodes(adf, 'orderedList');
    assert.strictEqual(orderedLists.length, 1, `expected 1 orderedList, got ${orderedLists.length}`);
    const listItems = collectNodes(orderedLists[0], 'listItem');
    assert.strictEqual(listItems.length, 3, `expected 3 listItem children, got ${listItems.length}`);
    console.log('  PASS: exactly 1 orderedList with 3 listItem children');

    // 2. List item text matches the step content
    const itemTexts = listItems.map(item => collectTextNodes(item).join(''));
    assert(itemTexts.some(t => t.includes('Open the editor')), 'missing "Open the editor"');
    assert(itemTexts.some(t => t.includes('Navigate to the settings panel')), 'missing "Navigate to the settings panel"');
    assert(itemTexts.some(t => t.includes('Toggle the feature flag and save')), 'missing "Toggle the feature flag and save"');
    console.log('  PASS: list items contain expected step text');

    // 3. No heading node contains step content
    const headings = collectNodes(adf, 'heading');
    const headingTexts = headings.map(h => collectTextNodes(h).join(''));
    for (const step of ['Open the editor', 'Navigate to the settings panel', 'Toggle the feature flag and save']) {
      assert(!headingTexts.some(t => t.includes(step)), `step "${step}" incorrectly parsed as heading`);
    }
    console.log('  PASS: no heading node contains step content');

    // 4. Level-3 headings preserved
    const h3s = headings.filter(h => (h.attrs as { level: number }).level === 3);
    const h3Texts = h3s.map(h => collectTextNodes(h).join(''));
    assert(h3Texts.some(t => t.includes('Steps to Reproduce')), 'missing "Steps to Reproduce" heading');
    assert(h3Texts.some(t => t.includes('Expected Behaviour')), 'missing "Expected Behaviour" heading');
    console.log('  PASS: level-3 headings preserved');

    console.log('\nAll ordered-list normalization smoke tests passed.\n');
  } finally {
    await app.close();
  }
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
