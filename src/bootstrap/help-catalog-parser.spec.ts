import * as path from 'path';
import { getCommandHelpCatalog } from './help-catalog-parser';

const catalog = getCommandHelpCatalog(path.join(__dirname, '..', 'commands'));

describe('getCommandHelpCatalog', () => {
  it('preserves option abbreviations from command decorators', () => {
    const entry = catalog['issue:generate'];

    expect(entry.options).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          flags: '-f, --format <format>',
          description: 'Output format (json|md|yaml|yml) - default: md',
        }),
        expect.objectContaining({
          flags: '-r, --repos <repos...>',
          description:
            'Space-separated list of repositories affected by this ticket (workspace/repo or repo-name)',
        }),
      ]),
    );
  });

  it('extracts example comments alongside command strings', () => {
    const entry = catalog['issue:generate'];

    expect(entry.examples).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          comment: 'Generate ticket from a URL',
          command: 'wf issue:generate https://example.com/spec',
        }),
        expect.objectContaining({
          comment: 'Save with overridden title',
          command:
            'wf issue:generate ./requirements.md --title "Add OAuth2" --save',
        }),
      ]),
    );
  });
});
