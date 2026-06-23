/**
 * Manual Test: adfToMarkdown regression — silent data loss for unhandled ADF node types
 *
 * Run: nr test:manual -- test-adf-to-markdown-regression
 *
 * Verifies that hardBreak, blockquote, rule, inlineCard, mention, emoji,
 * nested lists, multi-paragraph list items, and table nodes are all
 * preserved in the markdown output instead of being silently dropped.
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
  console.log('\nManual Test: adfToMarkdown regression — silent data loss fix\n');

  const service = createJiraService();

  // 1. hardBreak within a paragraph
  {
    const md = service.adfToMarkdown({
      type: 'doc',
      version: 1,
      content: [
        {
          type: 'paragraph',
          content: [{ type: 'text', text: 'Line A' }, { type: 'hardBreak' }, { type: 'text', text: 'Line B' }],
        },
      ],
    });
    assert(md.includes('Line A\nLine B'), `hardBreak lost: ${JSON.stringify(md)}`);
    console.log('  PASS: hardBreak preserved');
  }

  // 2. blockquote
  {
    const md = service.adfToMarkdown({
      type: 'doc',
      version: 1,
      content: [
        {
          type: 'blockquote',
          content: [
            {
              type: 'paragraph',
              content: [{ type: 'text', text: 'Quoted' }],
            },
          ],
        },
      ],
    });
    assert(md.includes('> Quoted'), `blockquote lost: ${JSON.stringify(md)}`);
    console.log('  PASS: blockquote preserved');
  }

  // 3. rule (horizontal rule)
  {
    const md = service.adfToMarkdown({
      type: 'doc',
      version: 1,
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'Before' }] },
        { type: 'rule' },
        { type: 'paragraph', content: [{ type: 'text', text: 'After' }] },
      ],
    });
    assert(md.includes('---'), `rule lost: ${JSON.stringify(md)}`);
    console.log('  PASS: rule preserved');
  }

  // 4. inlineCard
  {
    const md = service.adfToMarkdown({
      type: 'doc',
      version: 1,
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'Link: ' },
            {
              type: 'inlineCard',
              attrs: { url: 'https://jira.example.com/browse/WBP-100' },
            },
          ],
        },
      ],
    });
    assert(md.includes('https://jira.example.com/browse/WBP-100'), `inlineCard lost: ${JSON.stringify(md)}`);
    console.log('  PASS: inlineCard preserved');
  }

  // 5. mention
  {
    const md = service.adfToMarkdown({
      type: 'doc',
      version: 1,
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'Assigned to ' },
            { type: 'mention', attrs: { text: '@alice' } },
          ],
        },
      ],
    });
    assert(md.includes('@alice'), `mention lost: ${JSON.stringify(md)}`);
    console.log('  PASS: mention preserved');
  }

  // 6. emoji
  {
    const md = service.adfToMarkdown({
      type: 'doc',
      version: 1,
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'Status: ' },
            { type: 'emoji', attrs: { shortName: ':thumbsup:' } },
          ],
        },
      ],
    });
    assert(md.includes(':thumbsup:'), `emoji lost: ${JSON.stringify(md)}`);
    console.log('  PASS: emoji preserved');
  }

  // 7. nested bullet list
  {
    const md = service.adfToMarkdown({
      type: 'doc',
      version: 1,
      content: [
        {
          type: 'bulletList',
          content: [
            {
              type: 'listItem',
              content: [
                {
                  type: 'paragraph',
                  content: [{ type: 'text', text: 'Parent' }],
                },
                {
                  type: 'bulletList',
                  content: [
                    {
                      type: 'listItem',
                      content: [
                        {
                          type: 'paragraph',
                          content: [{ type: 'text', text: 'Child' }],
                        },
                      ],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    });
    assert(md.includes('Parent'), `nested list parent lost: ${JSON.stringify(md)}`);
    assert(md.includes('Child'), `nested list child lost: ${JSON.stringify(md)}`);
    console.log('  PASS: nested bullet list preserved');
  }

  // 8. multi-paragraph list item
  {
    const md = service.adfToMarkdown({
      type: 'doc',
      version: 1,
      content: [
        {
          type: 'bulletList',
          content: [
            {
              type: 'listItem',
              content: [
                {
                  type: 'paragraph',
                  content: [{ type: 'text', text: 'Para one' }],
                },
                {
                  type: 'paragraph',
                  content: [{ type: 'text', text: 'Para two' }],
                },
              ],
            },
          ],
        },
      ],
    });
    assert(md.includes('Para one'), `multi-para first lost: ${JSON.stringify(md)}`);
    assert(md.includes('Para two'), `multi-para second lost: ${JSON.stringify(md)}`);
    assert(!md.includes('Para onePara two'), `multi-para concatenated without separator: ${JSON.stringify(md)}`);
    console.log('  PASS: multi-paragraph list item separated');
  }

  // 9. table
  {
    const md = service.adfToMarkdown({
      type: 'doc',
      version: 1,
      content: [
        {
          type: 'table',
          content: [
            {
              type: 'tableRow',
              content: [
                {
                  type: 'tableHeader',
                  content: [
                    {
                      type: 'paragraph',
                      content: [{ type: 'text', text: 'Name' }],
                    },
                  ],
                },
                {
                  type: 'tableHeader',
                  content: [
                    {
                      type: 'paragraph',
                      content: [{ type: 'text', text: 'Value' }],
                    },
                  ],
                },
              ],
            },
            {
              type: 'tableRow',
              content: [
                {
                  type: 'tableCell',
                  content: [
                    {
                      type: 'paragraph',
                      content: [{ type: 'text', text: 'foo' }],
                    },
                  ],
                },
                {
                  type: 'tableCell',
                  content: [
                    {
                      type: 'paragraph',
                      content: [{ type: 'text', text: 'bar' }],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    });
    assert(md.includes('| Name | Value |'), `table header lost: ${JSON.stringify(md)}`);
    assert(md.includes('| foo | bar |'), `table row lost: ${JSON.stringify(md)}`);
    assert(md.includes('| --- | --- |'), `table separator lost: ${JSON.stringify(md)}`);
    console.log('  PASS: table preserved');
  }

  console.log('\nAll adfToMarkdown regression tests passed.\n');
}

main();
