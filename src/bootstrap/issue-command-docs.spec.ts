import {
  hasReadmeCommandDocDrift,
  synchronizeReadmeCommandDocs,
} from './issue-command-docs';
import { CommandHelpEntry } from './help-catalog-parser';

const issueGenerateEntry: CommandHelpEntry = {
  description:
    'Generate ticket descriptions from local files, repo-scoped artifacts via --repos, URLs, or Jira keys; can use an agent backend when stages.generate.agent: true is configured',
  usage: 'wf issue:generate <sources...> [options]',
  options: [
    {
      flags: '-f, --format <format>',
      description: 'Output format (json|md|yaml|xml) - default from env',
    },
    {
      flags: '-r, --repos <repos...>',
      description:
        'Space-separated list of repositories affected by this ticket (workspace/repo or repo-name)',
    },
  ],
  examples: [
    {
      comment: 'Generate ticket from a URL',
      command: 'wf issue:generate https://example.com/spec',
    },
    {
      comment: 'Save with overridden title',
      command:
        'wf issue:generate ./requirements.md --title "Add OAuth2" --save',
    },
  ],
};

describe('synchronizeReadmeCommandDocs', () => {
  it('replaces generated command blocks without touching surrounding prose', () => {
    const original = [
      '#### `wf issue:generate <sources...>`',
      '',
      '<!-- BEGIN GENERATED COMMAND DOCS: issue:generate -->',
      'stale generated content',
      '<!-- END GENERATED COMMAND DOCS: issue:generate -->',
      '',
      'Manual prose that must stay in README.',
      '',
      '---',
    ].join('\n');

    const updated = synchronizeReadmeCommandDocs(original, {
      'issue:generate': issueGenerateEntry,
    });

    expect(updated).toContain(
      '<!-- BEGIN GENERATED COMMAND DOCS: issue:generate -->',
    );
    expect(updated).toContain(
      'Generate ticket descriptions from local files, repo-scoped artifacts via --repos, URLs, or Jira keys; can use an agent backend when stages.generate.agent: true is configured',
    );
    expect(updated).toContain('# Generate ticket from a URL');
    expect(updated).toContain('`-f, --format <format>`');
    expect(updated).toContain('Manual prose that must stay in README.');
    expect(updated).not.toContain('stale generated content');
  });

  it('detects README drift when generated blocks are stale', () => {
    const staleReadme = [
      '#### `wf issue:generate <sources...>`',
      '',
      '<!-- BEGIN GENERATED COMMAND DOCS: issue:generate -->',
      'stale generated content',
      '<!-- END GENERATED COMMAND DOCS: issue:generate -->',
      '',
      '---',
    ].join('\n');

    expect(
      hasReadmeCommandDocDrift(staleReadme, {
        'issue:generate': issueGenerateEntry,
      }),
    ).toBe(true);
    expect(
      hasReadmeCommandDocDrift(
        synchronizeReadmeCommandDocs(staleReadme, {
          'issue:generate': issueGenerateEntry,
        }),
        {
          'issue:generate': issueGenerateEntry,
        },
      ),
    ).toBe(false);
  });
});
