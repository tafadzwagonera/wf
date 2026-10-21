import * as path from 'node:path';
import * as fs from 'node:fs';
import { getCommandHelpCatalog } from '../../bootstrap/help-catalog-parser';
import { COMMAND_DOCS } from './command-docs.registry';

const commandsDir = path.join(__dirname, '..', '..', 'commands');
const catalog = getCommandHelpCatalog(commandsDir);

afterEach(() => {
  jest.restoreAllMocks();
});

describe('COMMAND_DOCS registry keys', () => {
  it('every registry key maps to a parsed @Command name', () => {
    for (const key of Object.keys(COMMAND_DOCS)) {
      expect(catalog[key]).toBeDefined();
    }
  });

  it('issue:implement has a registry entry', () => {
    expect(COMMAND_DOCS).toHaveProperty('issue:implement');
  });
});

describe('COMMAND_DOCS no stale arrays', () => {
  it('no *.command.ts under src/commands still declares a *_EXAMPLES array', () => {
    const commandsDir = path.join(__dirname, '..', '..', 'commands');
    const commandFiles = fs
      .readdirSync(commandsDir)
      .filter(f => f.endsWith('.command.ts') && !f.endsWith('.spec.ts'));

    for (const file of commandFiles) {
      const source = fs.readFileSync(path.join(commandsDir, file), 'utf8');
      const hasArray = /const\s+\w+_EXAMPLES\s*:\s*CliExample\[]/.test(source);
      expect({ file, hasArray }).toEqual({ file, hasArray: false });
    }
  });
});

describe('COMMAND_DOCS registry↔catalog equality', () => {
  it('catalog examples match registry examples for every registry key', () => {
    for (const key of Object.keys(COMMAND_DOCS) as (keyof typeof COMMAND_DOCS)[]) {
      const registryExamples = COMMAND_DOCS[key].examples;
      const catalogExamples = catalog[key]?.examples ?? [];
      expect(catalogExamples).toEqual(registryExamples);
    }
  });
});

type CommandDocsEntry = (typeof COMMAND_DOCS)[keyof typeof COMMAND_DOCS];
type CommandDocsCase = [keyof typeof COMMAND_DOCS, CommandDocsEntry];

describe('COMMAND_DOCS summary contract', () => {
  const cases = Object.entries(COMMAND_DOCS) as CommandDocsCase[];

  it.each(cases)('%s summary is a prefix of its @Command description', (name, docs) => {
    expect(catalog[name]).toBeDefined();
    expect(catalog[name].description.startsWith(docs.summary)).toBe(true);
  });

  it.each(cases)('%s summary is at most 120 characters', (name, docs) => {
    expect(docs.summary.length).toBeLessThanOrEqual(120);
  });

  it.each(cases)('%s summary ends with a period', (name, docs) => {
    expect(docs.summary.endsWith('.')).toBe(true);
  });
});
