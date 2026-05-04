import chalk from 'chalk';

const COMMAND_TOKEN_PATTERN = /"[^"]*"|'[^']*'|[^\s]+/g;

/**
 * Split a CLI command string into shell-like tokens while preserving quoted values.
 *
 * @param command - Full CLI command text
 * @returns Ordered command tokens
 */
export const tokenizeCliCommand = (command: string): string[] =>
  command.match(COMMAND_TOKEN_PATTERN) ?? [];

/**
 * Apply the shared help/example color theme to CLI command tokens.
 *
 * @param command - Full CLI command text
 * @returns ANSI-colored command tokens
 */
export const formatCliCommandTokens = (command: string): string[] => {
  const tokens = tokenizeCliCommand(command);
  const coloredTokens: string[] = [];
  let previousWasFlag = false;

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];

    if (index === 0 && token === 'wf') {
      coloredTokens.push(chalk.cyan(token));
      previousWasFlag = false;
      continue;
    }

    if (token.startsWith('-')) {
      coloredTokens.push(chalk.yellow(token));
      previousWasFlag = true;
      continue;
    }

    if (previousWasFlag) {
      coloredTokens.push(chalk.green(token));
      previousWasFlag = false;
      continue;
    }

    coloredTokens.push(token);
    previousWasFlag = false;
  }

  return coloredTokens;
};

/**
 * Color a CLI command string using the shared help/example visual language.
 *
 * @param command - Full CLI command text
 * @returns ANSI-colored command string
 */
export const formatCliCommand = (command: string): string =>
  formatCliCommandTokens(command).join(' ');
