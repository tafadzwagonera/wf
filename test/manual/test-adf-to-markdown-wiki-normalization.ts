/**
 * Manual Test: adfToMarkdown wiki markup normalization
 *
 * Run: nr test:manual -- test-adf-to-markdown-wiki-normalization
 *
 * Verifies that Jira wiki markup patterns embedded in ADF text nodes
 * ({code:lang}, {noformat}, {{monospace}}, # ordered-list, expand, panel,
 * status, date, and strikethrough marks) are converted to standard markdown
 * instead of passing through as literal wiki syntax.
 */

import assert from 'assert';
import { JiraService } from '../../src/integrations/jira/jira.service';

const createJiraService = (): JiraService =>
  new JiraService(
    {
      get: (key: string) =>
        ({
          'atlassian.baseUrl': 'https://test.atlassian.net',
          'atlassian.email': 'test@example.com',
          'atlassian.apiToken': 'test-token',
          'atlassian.jira.defaultProject': 'WBP',
        })[key],
    } as any,
    { post: () => undefined } as any,
    { warn: () => undefined, success: () => undefined } as any,
    { isPlatformEnabled: () => true } as any
  );

function main() {
  console.log('\nManual Test: adfToMarkdown wiki markup normalization\n');

  const service = createJiraService();

  // 1. {code:lang}...{code} blocks → markdown code fences
  {
    const md = service.adfToMarkdown({
      type: 'doc',
      version: 1,
      content: [
        {
          type: 'paragraph',
          content: [
            {
              type: 'text',
              text: '{code:css}@media print {\n.a4-page {\ndisplay: block;\n}\n}{code}',
            },
          ],
        },
      ],
    });
    assert(md.includes('```css'), `{code:css} not converted: ${JSON.stringify(md)}`);
    assert(!md.includes('{code:css}'), `{code:css} still present: ${JSON.stringify(md)}`);
    assert(!md.includes('{code}'), `{code} still present: ${JSON.stringify(md)}`);
    console.log('  PASS: {code:lang} blocks converted to code fences');
  }

  // 2. {noformat}...{noformat} → code fences
  {
    const md = service.adfToMarkdown({
      type: 'doc',
      version: 1,
      content: [
        {
          type: 'paragraph',
          content: [{ type: 'text', text: '{noformat}raw output here{noformat}' }],
        },
      ],
    });
    assert(md.includes('```\nraw output here\n```'), `{noformat} not converted: ${JSON.stringify(md)}`);
    assert(!md.includes('{noformat}'), `{noformat} still present: ${JSON.stringify(md)}`);
    console.log('  PASS: {noformat} blocks converted to code fences');
  }

  // 3. {{monospace}} → inline code
  {
    const md = service.adfToMarkdown({
      type: 'doc',
      version: 1,
      content: [
        {
          type: 'paragraph',
          content: [
            {
              type: 'text',
              text: 'The {{bufferPx}} variable and {{break-inside}} rule.',
            },
          ],
        },
      ],
    });
    assert(md.includes('`bufferPx`'), `{{bufferPx}} not converted: ${JSON.stringify(md)}`);
    assert(md.includes('`break-inside`'), `{{break-inside}} not converted: ${JSON.stringify(md)}`);
    assert(!md.includes('{{'), `{{ still present: ${JSON.stringify(md)}`);
    console.log('  PASS: {{monospace}} converted to inline code');
  }

  // 4. # ordered list items (consecutive) → numbered list
  {
    const md = service.adfToMarkdown({
      type: 'doc',
      version: 1,
      content: [
        {
          type: 'paragraph',
          content: [
            {
              type: 'text',
              text: '# *Ghost page* - blank trailing page\n# *Footer gap* - red footer bar\n# *Content splitting* - day blocks split',
            },
          ],
        },
      ],
    });
    assert(md.includes('1. '), `missing item 1: ${JSON.stringify(md)}`);
    assert(md.includes('2. '), `missing item 2: ${JSON.stringify(md)}`);
    assert(md.includes('3. '), `missing item 3: ${JSON.stringify(md)}`);
    assert(!/^# \*/m.test(md), `wiki # still present: ${JSON.stringify(md)}`);
    console.log('  PASS: # ordered list items converted to numbered list');
  }

  // 5. expand node preserves title and content
  {
    const md = service.adfToMarkdown({
      type: 'doc',
      version: 1,
      content: [
        {
          type: 'expand',
          attrs: { title: 'Technical Details' },
          content: [
            {
              type: 'paragraph',
              content: [{ type: 'text', text: 'Detailed info here.' }],
            },
          ],
        },
      ],
    });
    assert(md.includes('Technical Details'), `expand title lost: ${JSON.stringify(md)}`);
    assert(md.includes('Detailed info here.'), `expand body lost: ${JSON.stringify(md)}`);
    console.log('  PASS: expand node preserves title and content');
  }

  // 6. panel node preserves content
  {
    const md = service.adfToMarkdown({
      type: 'doc',
      version: 1,
      content: [
        {
          type: 'panel',
          attrs: { panelType: 'info' },
          content: [
            {
              type: 'paragraph',
              content: [{ type: 'text', text: 'Info panel content.' }],
            },
          ],
        },
      ],
    });
    assert(md.includes('Info panel content.'), `panel content lost: ${JSON.stringify(md)}`);
    console.log('  PASS: panel node preserves content');
  }

  // 7. status inline node
  {
    const md = service.adfToMarkdown({
      type: 'doc',
      version: 1,
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'Status: ' },
            { type: 'status', attrs: { text: 'IN PROGRESS', color: 'blue' } },
          ],
        },
      ],
    });
    assert(md.includes('IN PROGRESS'), `status lost: ${JSON.stringify(md)}`);
    console.log('  PASS: status inline node preserved');
  }

  // 8. strikethrough mark
  {
    const md = service.adfToMarkdown({
      type: 'doc',
      version: 1,
      content: [
        {
          type: 'paragraph',
          content: [{ type: 'text', text: 'removed', marks: [{ type: 'strike' }] }],
        },
      ],
    });
    assert(md.includes('~~removed~~'), `strikethrough lost: ${JSON.stringify(md)}`);
    console.log('  PASS: strikethrough mark preserved');
  }

  // 9. WBP-3144-like combined document (integration)
  {
    const md = service.adfToMarkdown({
      type: 'doc',
      version: 1,
      content: [
        {
          type: 'heading',
          attrs: { level: 3 },
          content: [{ type: 'text', text: 'Summary' }],
        },
        {
          type: 'paragraph',
          content: [
            {
              type: 'text',
              text: 'The tour itinerary PDF generator produces three related visual defects on multi-page A4 documents:',
            },
          ],
        },
        {
          type: 'paragraph',
          content: [
            {
              type: 'text',
              text: '# *Ghost page* - blank trailing page\n# *Footer gap* - red footer bar issue\n# *Content splitting* - day blocks split arbitrarily',
            },
          ],
        },
        {
          type: 'paragraph',
          content: [
            {
              type: 'text',
              text: 'Evidence of root cause: The {{bufferPx}} variable controls spacing.',
            },
          ],
        },
        {
          type: 'heading',
          attrs: { level: 3 },
          content: [{ type: 'text', text: 'Technical Details' }],
        },
        {
          type: 'paragraph',
          content: [
            {
              type: 'text',
              text: '{code:css}@media print {\n.a4-page {\ndisplay: block;\n}\n}{code}',
            },
          ],
        },
      ],
    });
    assert(md.includes('### Summary'), `heading lost: ${JSON.stringify(md)}`);
    assert(md.includes('1. '), `ordered list lost: ${JSON.stringify(md)}`);
    assert(md.includes('`bufferPx`'), `inline code lost: ${JSON.stringify(md)}`);
    assert(md.includes('```css'), `code fence lost: ${JSON.stringify(md)}`);
    assert(!md.includes('{code:css}'), `wiki code block leaked: ${JSON.stringify(md)}`);
    assert(!md.includes('{{bufferPx}}'), `wiki monospace leaked: ${JSON.stringify(md)}`);
    console.log('  PASS: WBP-3144-like combined document (integration)');
  }

  // 10. * bullet items → markdown bullet list
  {
    const md = service.adfToMarkdown({
      type: 'doc',
      version: 1,
      content: [
        {
          type: 'paragraph',
          content: [
            {
              type: 'text',
              text: '* Introduce a normalization utility.\n* The normalizer must operate on the lowest-common-denominator principle.',
            },
          ],
        },
      ],
    });
    assert(md.includes('- Introduce'), `wiki * bullet not converted: ${JSON.stringify(md)}`);
    assert(!/^\* /m.test(md), `wiki * still present: ${JSON.stringify(md)}`);
    console.log('  PASS: * bullet items converted to - bullet list');
  }

  // 11. {noformat} spanning multiple ADF paragraphs
  {
    const md = service.adfToMarkdown({
      type: 'doc',
      version: 1,
      content: [
        {
          type: 'paragraph',
          content: [
            {
              type: 'text',
              text: '{noformat}italic text → rendered as italic',
            },
          ],
        },
        {
          type: 'paragraph',
          content: [
            {
              type: 'text',
              text: '→ plain text fallback{noformat}',
            },
          ],
        },
      ],
    });
    assert(!md.includes('{noformat}'), `{noformat} still present: ${JSON.stringify(md)}`);
    assert(md.includes('```'), `code fence missing: ${JSON.stringify(md)}`);
    assert(md.includes('italic text'), `content lost: ${JSON.stringify(md)}`);
    console.log('  PASS: {noformat} across paragraphs converted');
  }

  // 12. WBP-3145-like combined document (integration)
  {
    const md = service.adfToMarkdown({
      type: 'doc',
      version: 1,
      content: [
        {
          type: 'heading',
          attrs: { level: 3 },
          content: [{ type: 'text', text: 'Summary' }],
        },
        {
          type: 'paragraph',
          content: [
            {
              type: 'text',
              text: 'Italic text originating from Contentful renders incorrectly.',
            },
          ],
        },
        {
          type: 'paragraph',
          content: [
            {
              type: 'text',
              text: '{noformat}italic text → rendered as italic\n→ plain text fallback{noformat}',
            },
          ],
        },
        {
          type: 'heading',
          attrs: { level: 3 },
          content: [{ type: 'text', text: 'Technical Details' }],
        },
        {
          type: 'paragraph',
          content: [
            {
              type: 'text',
              text: '* Introduce a normalization utility.\n* The normalizer must operate on the lowest-common-denominator.\n* No backward-compatibility shim is needed.',
            },
          ],
        },
      ],
    });
    assert(md.includes('### Summary'), `heading lost: ${JSON.stringify(md)}`);
    assert(!md.includes('{noformat}'), `wiki noformat leaked: ${JSON.stringify(md)}`);
    assert(md.includes('- Introduce'), `bullet lost: ${JSON.stringify(md)}`);
    assert(!/^\* /m.test(md), `wiki * bullet leaked: ${JSON.stringify(md)}`);
    console.log('  PASS: WBP-3145-like combined document (integration)');
  }

  console.log('\nAll adfToMarkdown wiki normalization tests passed.\n');
}

main();
