import * as path from 'node:path';
import { getCommandHelpCatalog } from '../../bootstrap/help-catalog-parser';
import { getHelpText } from '../../bootstrap/help-output';
import { printCommandHeader } from './command-header.helper';
import { stripStyleMarkers } from './cli-help-render';

const catalog = getCommandHelpCatalog(path.join(__dirname, '..', '..', 'commands'));

afterEach(() => {
  jest.restoreAllMocks();
});

describe('printCommandHeader', () => {
  it('prints the summary line, a blank line, then the Examples: section', () => {
    const lines: string[] = [];
    jest.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      lines.push(args.join(' '));
    });

    printCommandHeader('issue:fetch');

    expect(lines[0]).toBe('Fetch ticket description from a tracker.');
    expect(lines[1]).toBe('');
    const examplesLine = lines.find(l => l.includes('Examples:'));
    expect(examplesLine).toBeDefined();
  });

  it('prints each example\'s authored comment as a # line above its command', () => {
    const lines: string[] = [];
    jest.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      lines.push(args.join(' '));
    });

    printCommandHeader('issue:fetch');

    const allOutput = lines.join('\n');
    expect(allOutput).toContain('# Fetch ticket from primary tracker');
  });

  it('caps issue:generate at exactly 5 command examples in the header', () => {
    const lines: string[] = [];
    jest.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      lines.push(args.join(' '));
    });

    printCommandHeader('issue:generate');

    const allOutput = lines.join('\n');
    const examplesSectionStart = allOutput.indexOf('Examples:');
    expect(examplesSectionStart).toBeGreaterThan(-1);
    const afterExamples = allOutput.slice(examplesSectionStart);
    const commandLines = afterExamples
      .split('\n')
      .map(l => stripStyleMarkers(l).trimStart())
      .filter(l => l.startsWith('wf ') || l.startsWith('yarn '));
    expect(commandLines).toHaveLength(5);
  });

  it('wraps long issue:create examples identically to getHelpText', () => {
    const lines: string[] = [];
    jest.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      lines.push(args.join(' '));
    });

    printCommandHeader('issue:create');

    const headerOutput = lines.join('\n');
    const headerExamplesStart = headerOutput.indexOf('Examples:');
    const headerExamplesSection = headerOutput.slice(headerExamplesStart);

    const helpText = getHelpText(['issue:create', '--help'], catalog);
    const helpExamplesStart = helpText.indexOf('Examples:');
    const helpExamplesSection = helpText.slice(helpExamplesStart);

    // issue:create has 5 examples: header cap matches full set, so sections are identical
    expect(headerExamplesSection).toBe(helpExamplesSection);
  });
});
