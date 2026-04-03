import chalk from 'chalk';

const COMMAND_TOKEN_PATTERN = /"[^"]*"|'[^']*'|[^\s]+/g;

/**
 * Color a CLI command string using the shared help/example visual language.
 *
 * @param command - Full CLI command text
 * @returns ANSI-colored command string
 */
export const formatCliCommand = (command: string): string => {
  const tokens = command.match(COMMAND_TOKEN_PATTERN) ?? [];
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

  return coloredTokens.join(' ');
};
