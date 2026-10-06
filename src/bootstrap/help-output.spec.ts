jest.mock('chalk', () => {
  const wrap
    = (label: string) =>
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
import * as fs from 'fs';
import { getHelpText } from './help-output';
import { getCommandHelpCatalog } from './help-catalog-parser';

const catalog = getCommandHelpCatalog(path.join(__dirname, '..', 'commands'));
const stripStyleTags = (value: string): string => value.replaceAll(/<\/?(?:cyan|yellow|green|gray|bold-cyan)>/g, '');
const normalizeWrappedText = (value: string): string => stripStyleTags(value).replaceAll(/\n\s*/g, ' ');

describe('getHelpText', () => {
  it('returns top-level help when no command is requested', () => {
    const helpText = getHelpText(['--help'], catalog);

    expect(helpText).toContain('<bold-cyan>Usage:</bold-cyan>');
    expect(helpText).toContain('issue:generate');
  });

  it('wraps top-level command descriptions to the 80-character limit', () => {
    const helpText = getHelpText(['--help'], catalog);
    const plainLines = helpText.split('\n').map(stripStyleTags);

    expect(plainLines.every(line => line.length <= 80)).toBe(true);
    expect(plainLines.some(line => /^ {25}\S/.test(line))).toBe(true);
  });

  it('returns stage-specific help for issue:generate', () => {
    const helpText = getHelpText(['issue:generate', '--help'], catalog);
    const plainHelpText = normalizeWrappedText(helpText);
    const plainLines = helpText.split('\n').map(stripStyleTags);

    expect(helpText).toContain('<bold-cyan>Usage:</bold-cyan> <cyan>wf</cyan> issue:generate <sources...> [options]');
    expect(plainHelpText).toContain(
      'Generate ticket descriptions from local files, repo-scoped artifacts via --repos, URLs, or ticket keys.'
    );
    expect(plainHelpText).toContain(
      'Repo-scoped generation inspects prior plan artifacts anywhere under ~/.wf/<repo>/**/*'
    );
    expect(plainHelpText).toContain(
      'When multiple repos are supplied, the synthesis prompt also compares repo conventions, including linter and formatter rules, and git-hook tools across checkouts'
    );
    expect(helpText).toContain('--title <title>');
    expect(helpText).toContain('<bold-cyan>Examples:</bold-cyan>');
    expect(helpText).toContain('<cyan>wf</cyan> issue:generate');
    expect(plainLines.every(line => line.length <= 80)).toBe(true);
  });

  it('aligns actual issue:generate option descriptions to the same column', () => {
    const helpText = getHelpText(['issue:generate', '--help'], catalog);
    const plainLines = helpText.split('\n').map(stripStyleTags);
    const issueGenerateEntry = catalog['issue:generate'];
    const descriptionColumns
      = issueGenerateEntry.options?.map(option => {
        const line = plainLines.find(candidate => candidate.startsWith(`  ${option.flags}`));
        if (!line) {
          return -1;
        }

        let index = 2 + option.flags.length;
        while (index < line.length && line[index] === ' ') {
          index += 1;
        }

        return index;
      }) ?? [];

    expect(descriptionColumns.length).toBeGreaterThan(0);
    expect(descriptionColumns.every(column => column > 0)).toBe(true);
    expect(new Set(descriptionColumns).size).toBe(1);
  });

  it('returns stage-specific help for issue:commit', () => {
    const helpText = getHelpText(['issue:commit', '-h'], catalog);

    expect(helpText).toContain('<bold-cyan>Usage:</bold-cyan> <cyan>wf</cyan> issue:commit [options]');
    expect(helpText).not.toContain('--no-ai');
    expect(helpText).toContain('--ticket-key <key>');
    expect(helpText).toContain('-c, --conventional');
    expect(helpText).not.toContain('[ticket-key]');
  });

  it('returns stage-specific help for issue:create', () => {
    const helpText = getHelpText(['issue:create', '--help'], catalog);
    const plainHelpText = normalizeWrappedText(helpText);

    expect(helpText).toContain('<bold-cyan>Usage:</bold-cyan> <cyan>wf</cyan> issue:create [input] [options]');
    expect(plainHelpText).toContain(
      'Create tickets from standardized input (file or stdin); Jira live runs enforce the ADF safety gate.'
    );
    expect(plainHelpText).toContain(
      '`stages.create` is verification-only and rejects provider, model, backend, or skills configuration.'
    );
    expect(helpText).toContain('--dry-run');
  });

  it('reflects current issue command flags', () => {
    const helpText = getHelpText(['issue', '--help'], catalog);

    expect(helpText).toContain('Complete workflow: fetch, plan, implement, review, and commit.');
    expect(helpText).toContain('--silent');
    expect(helpText).toContain('--pr');
    expect(helpText).toContain('--from <stage>');
    expect(helpText).not.toContain('--interactive');
    expect(helpText).not.toContain('--pr-hint');
  });

  it('reflects current plan, review, generate, and implement command flags', () => {
    const planHelpText = getHelpText(['issue:plan', '--help'], catalog);
    const reviewHelpText = getHelpText(['issue:review', '--help'], catalog);
    const generateHelpText = getHelpText(['issue:generate', '--help'], catalog);
    const implementHelpText = getHelpText(['issue:implement', '--help'], catalog);
    const plainGenerateHelpText = normalizeWrappedText(generateHelpText);
    const plainReviewHelpText = normalizeWrappedText(reviewHelpText);
    const plainImplementHelpText = normalizeWrappedText(implementHelpText);

    expect(planHelpText).toContain('Plan ticket implementation from a local artifact or repo-scoped custom artifact.');
    expect(normalizeWrappedText(planHelpText)).toContain(
      'wf retries once with explicit repair feedback when a draft omits rename targets, uses a non-allowlisted verification command, or contradicts detected test conventions'
    );
    expect(plainGenerateHelpText).toContain(
      'Local .md, .json, .yaml, and .yml files that parse as tickets are imported as tickets; files that are not recognized as ticket-formatted content remain plain file sources'
    );
    expect(plainGenerateHelpText).toContain(
      'Blank AI generate-stage responses fail fast with provider-aware diagnostics'
    );
    expect(planHelpText).toContain('--custom-plan <source.md>');
    expect(planHelpText).toContain('--repos <repos...>');
    expect(reviewHelpText).toContain('--criteria <path>');
    expect(reviewHelpText).toContain('--replace-criteria <path>');
    expect(plainReviewHelpText).toContain(
      'AI-powered code review of local changes, ticket-associated pull requests, or PR diffs.'
    );
    expect(plainReviewHelpText).toContain(
      'Tracker (jira|github|bitbucket) used to resolve a ticket source; defaults to the configured primary tracker'
    );
    expect(plainImplementHelpText).toContain('Anthropic Agent SDK, OpenAI Agents SDK, or Claude CLI headless mode');
    expect(plainImplementHelpText).toContain('Codex CLI uses codex exec --output-schema with a temporary schema file');
    expect(plainImplementHelpText).toContain('Assessed and complete events include done, not-applicable, partially-done, and not-done counts');
    expect(plainImplementHelpText).toContain('The fallback is logged once as `ai.model.fallback`');
    expect(plainImplementHelpText).toContain('~/.claude/CLAUDE.md and the repository-root CLAUDE.md');
    expect(plainImplementHelpText).toContain('~/.openai/AGENTS.md and the repository-root AGENTS.md');
    expect(plainImplementHelpText).toContain('targeted-write, step-count, and pattern routing');
    expect(plainImplementHelpText).toContain('stages.implement.modelRoutingThresholds');
    expect(plainImplementHelpText).toContain(
      'All backends emit stable task and tool progress lines plus explicit file mutation logs and verification logs'
    );
    expect(plainImplementHelpText).toContain(
      'Repo conventions are detected up front and threaded into every backend prompt, including continuation passes, so formatter and structural ESLint constraints survive context compaction'
    );
    expect(plainImplementHelpText).not.toContain('the OpenAI backend emits heuristic progress signals');
    expect(implementHelpText).toContain('<bold-cyan>Examples:</bold-cyan>');
    expect(plainImplementHelpText).not.toContain('Examples: wf issue:implement -k PROJ-123 |');
  });

  it('loads the catalog from dist/bootstrap when no catalog argument is supplied', () => {
    const distBootstrapDir = path.join(__dirname, '..', '..', 'dist', 'bootstrap');
    const distCatalogPath = path.join(distBootstrapDir, 'commands-help.catalog.json');
    const hadCatalog = fs.existsSync(distCatalogPath);
    const existingCatalog = hadCatalog ? fs.readFileSync(distCatalogPath, 'utf8') : null;

    fs.mkdirSync(distBootstrapDir, { recursive: true });
    fs.writeFileSync(distCatalogPath, JSON.stringify(catalog, null, 2), 'utf8');

    try {
      expect(() => getHelpText(['--help'])).not.toThrow();
      expect(getHelpText(['--help'])).toContain('issue');
    } finally {
      if (existingCatalog === null) {
        fs.unlinkSync(distCatalogPath);
      } else {
        fs.writeFileSync(distCatalogPath, existingCatalog, 'utf8');
      }
    }
  });

  it('parses concatenated descriptions and renamed flags directly from source', () => {
    const fetchHelpText = getHelpText(['issue:fetch', '--help'], catalog);
    const prHelpText = getHelpText(['issue:pr', '--help'], catalog);
    const plainFetchHelpText = normalizeWrappedText(fetchHelpText);

    expect(plainFetchHelpText).toContain(
      'Fetch ticket description from a tracker. NB: This command will override the locally generated artifact with the ticket description fetched from the specified tracker'
    );
    expect(prHelpText).toContain('Create a pull request from a plan artifact (auto-detects ticket from branch)');
    expect(prHelpText).toContain('--base <base>');
    expect(prHelpText).not.toContain('--target <branch>');
  });

  it('wraps help output to 80 columns and aligns option descriptions', () => {
    const helpText = getHelpText(['issue:demo', '--help'], {
      'issue:demo': {
        description:
          'Generate documentation from a deliberately verbose description that should wrap while staying readable in a standard terminal window.',
        usage: 'wf issue:demo <source> [options]',
        options: [
          {
            flags: '-a, --alpha <value>',
            description:
              'A long option description that should wrap onto a continuation line without shifting the description start column.',
          },
          {
            flags: '-b, --beta <value>',
            description:
              'Another long option description to verify that multiple wrapped options share the same description column.',
          },
        ],
        examples: [
          {
            comment: 'Run against a quoted URL source',
            command: 'wf issue:demo "https://example.com/a/really/long/path/that/needs/wrapping" --alpha value',
          },
        ],
      },
    });

    const plainLines = helpText.split('\n').map(stripStyleTags);
    const optionLines = plainLines.filter(line => line.includes('A long option description'));
    const secondOptionLines = plainLines.filter(line => line.includes('Another long option description'));
    const alphaDescriptionColumn = optionLines[0].indexOf('A long option');
    const betaDescriptionColumn = secondOptionLines[0].indexOf('Another long');

    expect(plainLines.every(line => line.length <= 80)).toBe(true);
    expect(alphaDescriptionColumn).toBeGreaterThan(0);
    expect(betaDescriptionColumn).toBe(alphaDescriptionColumn);
    expect(helpText).toContain('<yellow>--alpha</yellow>');
  });

  it('no command help text contains the legacy --platform flag', () => {
    for (const command of Object.keys(catalog)) {
      const helpText = getHelpText([command, '--help'], catalog);
      expect(helpText).not.toContain('--platform');
    }
  });

  it('tracker-aware commands expose -t, --tracker', () => {
    const trackerCommands = [
      'issue',
      'issue:fetch',
      'issue:plan',
      'issue:implement',
      'issue:commit',
      'issue:create',
      'issue:pr',
      'issue:generate',
    ];
    for (const command of trackerCommands) {
      const helpText = getHelpText([command, '--help'], catalog);
      expect(helpText).toContain('--tracker');
    }
  });
});
