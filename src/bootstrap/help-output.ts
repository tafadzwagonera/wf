import * as fs from 'node:fs';
import * as path from 'node:path';
import chalk from 'chalk';
import { formatCliCommandTokens } from '../common/utils/cli-command-colors';
import { CommandHelpEntry, CommandHelpOption } from './help-catalog-parser';
import { FileSystemError } from '../common/utils/errors';
import { isSeaRuntime, readRuntimeAsset } from '../common/utils/runtime-assets';
import {
  buildWrappedLines,
  getVisibleLength,
  renderExamplesSection,
  wrapStyledTokens,
} from '../common/utils/cli-help-render';

const CATALOG_PATH = path.join(__dirname, '..', '..', 'dist', 'bootstrap', 'commands-help.catalog.json');
const HELP_FLAG_PATTERN = /^--help$|^-h$/;
const OPTION_FLAGS_COLUMN_WIDTH = 28;
const OPTION_DESCRIPTION_COLUMN = 2 + OPTION_FLAGS_COLUMN_WIDTH + 2;
const COMMAND_NAME_COLUMN_WIDTH = 21;
const COMMAND_DESCRIPTION_COLUMN = 2 + COMMAND_NAME_COLUMN_WIDTH + 2;

const loadCatalogFromDisk = (): Record<string, CommandHelpEntry> => {
  if (!isSeaRuntime() && !fs.existsSync(CATALOG_PATH)) {
    throw new FileSystemError(`Help catalog not found at ${CATALOG_PATH}. Run \`yarn build\` to generate it.`);
  }

  return JSON.parse(readRuntimeAsset('commands-help.catalog.json', CATALOG_PATH)) as Record<string, CommandHelpEntry>;
};

const findRequestedCommand = (argv: string[]): string | undefined => argv.find(arg => !arg.startsWith('-'));

function wrapText(text: string, initialIndent = '', subsequentIndent = initialIndent): string[] {
  const words = text.split(/\s+/).filter(word => word.length > 0);

  if (words.length === 0) {
    return [initialIndent.trimEnd()];
  }

  return buildWrappedLines(words, initialIndent, subsequentIndent);
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

const formatCommandListLine = (commandName: string, description: string): string[] => {
  if (commandName.length <= COMMAND_NAME_COLUMN_WIDTH) {
    return wrapText(description, `  ${commandName.padEnd(COMMAND_NAME_COLUMN_WIDTH)}  `, ' '.repeat(COMMAND_DESCRIPTION_COLUMN));
  }

  return [`  ${commandName}`, ...wrapText(description, ' '.repeat(COMMAND_DESCRIPTION_COLUMN), ' '.repeat(COMMAND_DESCRIPTION_COLUMN))];
};

function formatGlobalHelp(commandHelp: Record<string, CommandHelpEntry>): string {
  const commandLines = Object.entries(commandHelp).flatMap(
    ([commandName, commandEntry]) => formatCommandListLine(commandName, commandEntry.description)
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
    lines.push('', ...renderExamplesSection(entry.examples));
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

export { getVisibleLength };
