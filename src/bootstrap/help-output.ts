import * as fs from 'fs';
import * as path from 'path';
import chalk from 'chalk';
import { formatCliCommand } from '../shared/utils/cli-command-colors';
import { CommandHelpEntry } from './help-catalog-parser';

const CATALOG_PATH = path.join(__dirname, 'commands-help.catalog.json');
const HELP_FLAG_PATTERN = /^--help$|^-h$/;

const loadCatalogFromDisk = (): Record<string, CommandHelpEntry> => {
  if (!fs.existsSync(CATALOG_PATH)) {
    throw new Error(
      `Help catalog not found at ${CATALOG_PATH}. Run \`npm run build\` to generate it.`,
    );
  }

  return JSON.parse(fs.readFileSync(CATALOG_PATH, 'utf8')) as Record<
    string,
    CommandHelpEntry
  >;
};

const findRequestedCommand = (argv: string[]): string | undefined =>
  argv.find((arg) => !arg.startsWith('-'));

/**
 * Build pre-bootstrap help text without importing the Nest application graph.
 *
 * @param argv - Raw CLI argv values after the executable name
 * @param catalog - Optional catalog override; reads from disk when omitted
 * @returns Help text for the requested command or the top-level CLI
 */
export const getHelpText = (
  argv: string[],
  catalog?: Record<string, CommandHelpEntry>,
): string => {
  const commandHelp = catalog ?? loadCatalogFromDisk();
  const requestedCommand = findRequestedCommand(
    argv.filter((arg) => !HELP_FLAG_PATTERN.test(arg)),
  );
  const entry = requestedCommand ? commandHelp[requestedCommand] : undefined;

  if (!requestedCommand || !entry) {
    const commandLines = Object.entries(commandHelp).map(
      ([commandName, commandEntry]) =>
        `  ${commandName.padEnd(16)} ${commandEntry.description}`,
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

  const lines = [
    `${chalk.bold.cyan('Usage:')} ${formatCliCommand(entry.usage)}`,
    '',
    entry.description,
  ];

  if (entry.options?.length) {
    lines.push(
      '',
      chalk.bold.cyan('Options:'),
      ...entry.options.map((option) => `  ${option}`),
    );
  }

  if (entry.examples?.length) {
    lines.push(
      '',
      chalk.bold.cyan('Examples:'),
      ...entry.examples.map((example) => `  ${formatCliCommand(example)}`),
    );
  }

  return lines.join('\n');
};
