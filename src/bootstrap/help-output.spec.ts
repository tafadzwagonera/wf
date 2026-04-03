jest.mock('chalk', () => {
  const wrap =
    (label: string) =>
    (value: string): string =>
      `<${label}>${value}</${label}>`;

  return {
    __esModule: true,
    default: {
      cyan: wrap('cyan'),
      yellow: wrap('yellow'),
      green: wrap('green'),
      gray: wrap('gray'),
      bold: {
        cyan: wrap('bold-cyan'),
      },
    },
  };
});

import { getHelpText } from './help-output';

describe('getHelpText', () => {
  it('returns top-level help when no command is requested', () => {
    const helpText = getHelpText(['--help']);

    expect(helpText).toContain('<bold-cyan>Usage:</bold-cyan>');
    expect(helpText).toContain('issue:generate');
  });

  it('returns stage-specific help for issue:generate', () => {
    const helpText = getHelpText(['issue:generate', '--help']);

    expect(helpText).toContain(
      '<bold-cyan>Usage:</bold-cyan> <cyan>wf</cyan> issue:generate <sources...> [options]',
    );
    expect(helpText).toContain(
      'Generate ticket descriptions from multiple sources',
    );
    expect(helpText).toContain('--title <title>');
    expect(helpText).toContain('<bold-cyan>Examples:</bold-cyan>');
    expect(helpText).toContain('<cyan>wf</cyan> issue:generate');
  });

  it('returns stage-specific help for issue:commit', () => {
    const helpText = getHelpText(['issue:commit', '-h']);

    expect(helpText).toContain(
      '<bold-cyan>Usage:</bold-cyan> <cyan>wf</cyan> issue:commit [ticket-key] [options]',
    );
    expect(helpText).toContain('--no-ai');
  });

  it('reflects current issue command flags', () => {
    const helpText = getHelpText(['issue', '--help']);

    expect(helpText).toContain(
      'Complete workflow: fetch, plan, implement, review, and commit.',
    );
    expect(helpText).toContain('--chat-mode');
    expect(helpText).toContain('--pr');
    expect(helpText).toContain('--from <stage>');
    expect(helpText).not.toContain('--interactive');
    expect(helpText).not.toContain('--pr-hint');
  });

  it('reflects current run and review command flags', () => {
    const runHelpText = getHelpText(['run', '--help']);
    const reviewHelpText = getHelpText(['issue:review', '--help']);

    expect(runHelpText).toContain('--auto-execute');
    expect(runHelpText).not.toContain('--auto-approve');
    expect(reviewHelpText).toContain('--criteria <path>');
    expect(reviewHelpText).toContain('--replace-criteria <path>');
  });

  it('parses concatenated descriptions and renamed flags directly from source', () => {
    const fetchHelpText = getHelpText(['issue:fetch', '--help']);
    const prHelpText = getHelpText(['issue:pr', '--help']);

    expect(fetchHelpText).toContain(
      'Fetch ticket description from a platform. NB: This command will override the locally generated artifact with the ticket description fetched from the specified platform',
    );
    expect(prHelpText).toContain(
      'Create a pull request from a plan artifact (auto-detects ticket from branch)',
    );
    expect(prHelpText).toContain('--base <base>');
    expect(prHelpText).not.toContain('--target <branch>');
  });
});
