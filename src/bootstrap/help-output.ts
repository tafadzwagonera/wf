import * as fs from 'fs';
import * as path from 'path';
import chalk from 'chalk';
import { formatCliCommandTokens } from '../shared/utils/cli-command-colors';
import { CommandHelpEntry, CommandHelpExample, CommandHelpOption } from './help-catalog-parser';

const CATALOG_PATH = path.join(__dirname, '..', '..', 'dist', 'bootstrap', 'commands-help.catalog.json');
const HELP_FLAG_PATTERN = /^--help$|^-h$/;
const MAX_HELP_WIDTH = 80;
const OPTION_FLAGS_COLUMN_WIDTH = 28;
const OPTION_DESCRIPTION_COLUMN = 2 + OPTION_FLAGS_COLUMN_WIDTH + 2;
const ANSI_ESCAPE = String.fromCharCode(27);
const ANSI_PATTERN = new RegExp(`${ANSI_ESCAPE}\\[[0-9;]*m`, 'g');
const MOCK_STYLE_TAG_PATTERN = /<\/?(?:cyan|yellow|green|gray|bold-cyan)>/g;

const loadCatalogFromDisk = (): Record<string, CommandHelpEntry> => {
  if (!fs.existsSync(CATALOG_PATH)) {
    throw new Error(`Help catalog not found at ${CATALOG_PATH}. Run \`yarn build\` to generate it.`);
  }

  return JSON.parse(fs.readFileSync(CATALOG_PATH, 'utf8')) as Record<string, CommandHelpEntry>;
};

const findRequestedCommand = (argv: string[]): string | undefined => argv.find(arg => !arg.startsWith('-'));

const getVisibleLength = (value: string): number =>
  value.replace(ANSI_PATTERN, '').replace(MOCK_STYLE_TAG_PATTERN, '').length;

function findPreferredSplitIndex(candidate: string, maxTokenWidth: number): number {
  const splitMatches = Array.from(candidate.matchAll(/[/?&=_-]/g));
  return splitMatches.length > 0 ? (splitMatches.at(-1)?.index ?? 0) + 1 : maxTokenWidth;
}

function splitPlainLongToken(token: string, maxTokenWidth: number): string[] {
  if (token.length <= maxTokenWidth) return [token];
  const chunks: string[] = [];
  let remaining = token;
  while (remaining.length > maxTokenWidth) {
    const splitIndex = findPreferredSplitIndex(remaining.slice(0, maxTokenWidth), maxTokenWidth);
    chunks.push(remaining.slice(0, splitIndex));
    remaining = remaining.slice(splitIndex);
  }
  if (remaining.length > 0) {
    chunks.push(remaining);
  }
  return chunks;
}

const expandLongTokensForWrapping = (tokens: string[], maxTokenWidth: number): string[] =>
  tokens.flatMap(token => {
    if (getVisibleLength(token) <= maxTokenWidth) {
      return [token];
    }

    if (ANSI_PATTERN.test(token) || MOCK_STYLE_TAG_PATTERN.test(token)) {
      ANSI_PATTERN.lastIndex = 0;
      MOCK_STYLE_TAG_PATTERN.lastIndex = 0;
      return [token];
    }

    ANSI_PATTERN.lastIndex = 0;
    MOCK_STYLE_TAG_PATTERN.lastIndex = 0;
    return splitPlainLongToken(token, maxTokenWidth);
  });

function buildWrappedLines(tokens: string[], initialIndent: string, subsequentIndent: string): string[] {
  const lines: string[] = [];
  let currentLine = initialIndent;

  for (const token of tokens) {
    const nextLine = `${currentLine}${currentLine.trim().length === 0 ? '' : ' '}${token}`;

    if (getVisibleLength(nextLine) <= MAX_HELP_WIDTH || currentLine === initialIndent) {
      currentLine = nextLine;
      continue;
    }

    lines.push(currentLine);
    currentLine = `${subsequentIndent}${token}`;
  }

  lines.push(currentLine);
  return lines;
}

function wrapText(text: string, initialIndent = '', subsequentIndent = initialIndent): string[] {
  const words = text.split(/\s+/).filter(word => word.length > 0);

  if (words.length === 0) {
    return [initialIndent.trimEnd()];
  }

  return buildWrappedLines(words, initialIndent, subsequentIndent);
}

function wrapStyledTokens(tokens: string[], initialIndent = '', subsequentIndent = initialIndent): string[] {
  const normalizedTokens = expandLongTokensForWrapping(
    tokens,
    MAX_HELP_WIDTH - Math.max(getVisibleLength(initialIndent), getVisibleLength(subsequentIndent))
  );

  if (normalizedTokens.length === 0) {
    return [initialIndent.trimEnd()];
  }

  return buildWrappedLines(normalizedTokens, initialIndent, subsequentIndent);
}

const formatOptionLine = (option: CommandHelpOption): string[] => {
  const flags = option.flags;
  if (flags.length <= OPTION_FLAGS_COLUMN_WIDTH) {
    return wrapText(
      option.description,
      `  ${flags.padEnd(OPTION_FLAGS_COLUMN_WIDTH)}  `,
      ' '.repeat(OPTION_DESCRIPTION_COLUMN)
    );
  }

  return [
    `  ${flags}`,
    ...wrapText(option.description, ' '.repeat(OPTION_DESCRIPTION_COLUMN), ' '.repeat(OPTION_DESCRIPTION_COLUMN)),
  ];
};

const formatExampleLines = (example: CommandHelpExample): string[] => {
  return wrapStyledTokens(formatCliCommandTokens(example.command), '  ', '  ');
};

function formatGlobalHelp(commandHelp: Record<string, CommandHelpEntry>): string {
  const commandLines = Object.entries(commandHelp).map(
    ([commandName, commandEntry]) => `  ${commandName.padEnd(16)} ${commandEntry.description}`
  );

  return [
    `${chalk.bold.cyan('Usage:')} ${chalk.cyan('wf')} <command> [options]`,
    '',
    chalk.bold.cyan('Commands:'),
    ...commandLines,
    '',
    `${chalk.gray('Use')} ${chalk.cyan('wf')} <command> ${chalk.yellow('--help')} ${chalk.gray('for command-specific details.')}`,
  ].join('\n');
}

function formatCommandHelp(entry: CommandHelpEntry): string {
  const lines = [
    ...wrapStyledTokens([chalk.bold.cyan('Usage:'), ...formatCliCommandTokens(entry.usage)], '', '       '),
    '',
    ...wrapText(entry.description),
  ];

  if (entry.options?.length) {
    lines.push('', chalk.bold.cyan('Options:'), ...entry.options.flatMap(option => formatOptionLine(option)));
  }

  if (entry.examples?.length) {
    lines.push('', chalk.bold.cyan('Examples:'), ...entry.examples.flatMap(example => formatExampleLines(example)));
  }

  return lines.join('\n');
}

export function getHelpText(argv: string[], catalog?: Record<string, CommandHelpEntry>): string {
  const commandHelp = catalog ?? loadCatalogFromDisk();
  const requestedCommand = findRequestedCommand(argv.filter(arg => !HELP_FLAG_PATTERN.test(arg)));
  const entry = requestedCommand ? commandHelp[requestedCommand] : undefined;

  if (!requestedCommand || !entry) {
    return formatGlobalHelp(commandHelp);
  }

  return formatCommandHelp(entry);
}
