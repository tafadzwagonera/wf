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

import * as path from 'path';
import { getHelpText } from './help-output';
import { getCommandHelpCatalog } from './help-catalog-parser';

const catalog = getCommandHelpCatalog(path.join(__dirname, '..', 'commands'));

describe('getHelpText', () => {
  it('returns top-level help when no command is requested', () => {
    const helpText = getHelpText(['--help'], catalog);

    expect(helpText).toContain('<bold-cyan>Usage:</bold-cyan>');
    expect(helpText).toContain('issue:generate');
  });

  it('returns stage-specific help for issue:generate', () => {
    const helpText = getHelpText(['issue:generate', '--help'], catalog);

    expect(helpText).toContain(
      '<bold-cyan>Usage:</bold-cyan> <cyan>wf</cyan> issue:generate <sources...> [options]',
    );
    expect(helpText).toContain(
      'Generate ticket descriptions from local files, repo-scoped artifacts, URLs, Jira keys',
    );
    expect(helpText).toContain('--title <title>');
    expect(helpText).toContain('<bold-cyan>Examples:</bold-cyan>');
    expect(helpText).toContain('<cyan>wf</cyan> issue:generate');
  });

  it('returns stage-specific help for issue:commit', () => {
    const helpText = getHelpText(['issue:commit', '-h'], catalog);

    expect(helpText).toContain(
      '<bold-cyan>Usage:</bold-cyan> <cyan>wf</cyan> issue:commit [ticket-key] [options]',
    );
    expect(helpText).toContain('--no-ai');
  });

  it('reflects current issue command flags', () => {
    const helpText = getHelpText(['issue', '--help'], catalog);

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
    const runHelpText = getHelpText(['run', '--help'], catalog);
    const planHelpText = getHelpText(['issue:plan', '--help'], catalog);
    const reviewHelpText = getHelpText(['issue:review', '--help'], catalog);
    const implementHelpText = getHelpText(
      ['issue:implement', '--help'],
      catalog,
    );

    expect(planHelpText).toContain(
      'Plan ticket implementation from a local artifact or repo-scoped custom artifact.',
    );
    expect(planHelpText).toContain('--custom <source.md>');
    expect(planHelpText).toContain('--repos <repos...>');
    expect(runHelpText).toContain('--auto-execute');
    expect(runHelpText).not.toContain('--auto-approve');
    expect(reviewHelpText).toContain('--criteria <path>');
    expect(reviewHelpText).toContain('--replace-criteria <path>');
    expect(implementHelpText).toContain('Anthropic or OpenAI agent backend');
    expect(implementHelpText).toContain(
      '~/.claude/CLAUDE.md and the repository-root CLAUDE.md',
    );
    expect(implementHelpText).toContain(
      '~/.openai/OPENAI.md and the repository-root .openai/OPENAI.md',
    );
  });

  it('loads the catalog from dist/bootstrap when no catalog argument is supplied', () => {
    // After `npm run build` the catalog exists at dist/bootstrap/.
    // With the broken path (src/bootstrap/) this throws.
    expect(() => getHelpText(['--help'])).not.toThrow();
    expect(getHelpText(['--help'])).toContain('issue');
  });

  it('parses concatenated descriptions and renamed flags directly from source', () => {
    const fetchHelpText = getHelpText(['issue:fetch', '--help'], catalog);
    const prHelpText = getHelpText(['issue:pr', '--help'], catalog);

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
