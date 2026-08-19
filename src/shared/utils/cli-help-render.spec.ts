jest.mock('chalk', () => {
  const wrap = (label: string) => (value: string): string => `<${label}>${value}</${label}>`;
  return {
    __esModule: true,
    default: {
      cyan: wrap('cyan'),
      yellow: wrap('yellow'),
      green: wrap('green'),
      gray: wrap('gray'),
      bold: { cyan: wrap('bold-cyan') },
    },
  };
});

import { getVisibleLength, buildWrappedLines, wrapStyledTokens, renderExamplesSection, MAX_HELP_WIDTH } from './cli-help-render';
import type { CommandHelpExample } from '../types/bootstrap.types';

afterEach(() => {
  jest.restoreAllMocks();
});

describe('MAX_HELP_WIDTH', () => {
  it('is 80', () => {
    expect(MAX_HELP_WIDTH).toBe(80);
  });
});

describe('getVisibleLength', () => {
  it('returns the length of a plain string', () => {
    expect(getVisibleLength('hello world')).toBe(11);
  });

  it('strips real ANSI escape codes before counting', () => {
    const ansiColored = '\x1b[32mhello\x1b[0m';
    expect(getVisibleLength(ansiColored)).toBe(5);
  });

  it('strips mock style tags before counting', () => {
    expect(getVisibleLength('<bold-cyan>Examples:</bold-cyan>')).toBe('Examples:'.length);
    expect(getVisibleLength('<cyan>wf</cyan>')).toBe(2);
  });

  it('returns 0 for an empty string', () => {
    expect(getVisibleLength('')).toBe(0);
  });
});

describe('buildWrappedLines', () => {
  it('places all short tokens on a single line with the initial indent', () => {
    const lines = buildWrappedLines(['wf', 'issue:create', '-k', 'PROJ-123'], '  ', '  ');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toBe('  wf issue:create -k PROJ-123');
  });

  it('wraps onto a subsequent line when the token list exceeds MAX_HELP_WIDTH', () => {
    const long = 'x'.repeat(50);
    const lines = buildWrappedLines([long, long], '  ', '  ');
    expect(lines.length).toBeGreaterThan(1);
  });

  it('uses the initial indent on the first line and subsequentIndent on overflow lines', () => {
    const long = 'x'.repeat(50);
    const lines = buildWrappedLines([long, long], '  ', '    ');
    expect(lines[0].startsWith('  ')).toBe(true);
    expect(lines[1].startsWith('    ')).toBe(true);
  });

  it('always emits at least one line even for an empty token list', () => {
    const lines = buildWrappedLines([], '  ', '  ');
    expect(lines.length).toBeGreaterThanOrEqual(1);
  });
});

describe('wrapStyledTokens', () => {
  it('wraps styled tokens respecting MAX_HELP_WIDTH', () => {
    const long = 'a'.repeat(75);
    const lines = wrapStyledTokens([long, 'short'], '  ', '  ');
    expect(lines.length).toBeGreaterThan(1);
  });

  it('returns a single trimmed line for an empty token list', () => {
    const lines = wrapStyledTokens([], '  ', '  ');
    expect(lines).toHaveLength(1);
    expect(lines[0].trim()).toBe('');
  });
});

describe('renderExamplesSection', () => {
  const examples: CommandHelpExample[] = [
    { command: 'wf issue:create -k PROJ-1', comment: 'first' },
    { command: 'wf issue:create -k PROJ-2' },
    { command: 'wf issue:create -k PROJ-3' },
    { command: 'wf issue:create -k PROJ-4' },
    { command: 'wf issue:create -k PROJ-5' },
    { command: 'wf issue:create -k PROJ-6' },
  ];

  it('puts the Examples: heading as the first element', () => {
    const lines = renderExamplesSection(examples.slice(0, 1));
    expect(lines[0]).toBe('<bold-cyan>Examples:</bold-cyan>');
  });

  it('renders all examples when no limit is provided', () => {
    const joined = renderExamplesSection(examples).join('\n');
    for (let i = 1; i <= 6; i++) {
      expect(joined).toContain(`PROJ-${i}`);
    }
  });

  it('caps output at the given limit', () => {
    const lines = renderExamplesSection(examples, 5);
    expect(lines.join('\n')).toContain('PROJ-5');
    expect(lines.join('\n')).not.toContain('PROJ-6');
  });

  it('renders an authored comment as a wrapped gray line above its command', () => {
    const lines = renderExamplesSection(examples.slice(0, 1));
    expect(lines).toContain('<gray>  # first</gray>');
  });

  it('emits no comment line for an example without a comment', () => {
    const lines = renderExamplesSection(examples.slice(1, 2));
    expect(lines.some(l => l.trimStart().startsWith('#'))).toBe(false);
  });

  it('wraps a long comment across multiple gray lines within MAX_HELP_WIDTH', () => {
    const longComment = 'x '.repeat(60).trim();
    const lines = renderExamplesSection([{ command: 'wf issue:generate ./x', comment: longComment }]);
    const commentLines = lines.filter(l => l.startsWith('<gray>'));
    expect(commentLines.length).toBeGreaterThan(1);
  });

  it('returns only the heading for an empty examples array', () => {
    const lines = renderExamplesSection([]);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toBe('<bold-cyan>Examples:</bold-cyan>');
  });
});
