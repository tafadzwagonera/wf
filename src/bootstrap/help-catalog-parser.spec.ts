import * as path from 'node:path';
import { getCommandHelpCatalog } from './help-catalog-parser';

const commandsDir = path.join(__dirname, '..', 'commands');
const catalog = getCommandHelpCatalog(commandsDir);

describe('getCommandHelpCatalog', () => {
  it('restores the issue:review --session-id {UUID} example that the brace-splitting scrape dropped', () => {
    const examples = catalog['issue:review']?.examples ?? [];
    expect(examples).toHaveLength(8);
    const uuidExample = examples.find(e => e.command.includes('--session-id {UUID}'));
    expect(uuidExample).toBeDefined();
    expect(uuidExample?.command).toBe('wf issue:review --ticket-key WBP-2971 --session-id {UUID} -r service-bookingv3');
  });

  it('exposes all 9 issue:generate examples', () => {
    const examples = catalog['issue:generate']?.examples ?? [];
    expect(examples).toHaveLength(9);
  });

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
            'Space-separated repositories; the first repo anchors artifact storage and read context, remaining repos provide additional read context for the AI',
        }),
      ])
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
          comment: 'Generate with multiple repos so repo conventions, formatter rules, and git hooks are compared across checkouts',
          command: 'wf issue:generate ./requirements.md -r primary-repo secondary-repo --save',
        }),
        expect.objectContaining({
          comment: 'Save with overridden title',
          command: 'wf issue:generate ./requirements.md --title "Add OAuth2" --save',
        }),
      ])
    );
  });
});
