import chalk from 'chalk';

const COMMAND_TOKEN_PATTERN = /"[^"]*"|'[^']*'|[^\s]+/g;

/**
 * Split a CLI command string into shell-like tokens while preserving quoted values.
 *
 * @param command - Full CLI command text
 * @returns Ordered command tokens
 */
export const tokenizeCliCommand = (command: string): string[] => command.match(COMMAND_TOKEN_PATTERN) ?? [];

const colorizeToken = (token: string, index: number, previousWasFlag: boolean): { text: string; nextFlag: boolean } => {
  if (index === 0 && token === 'wf') return { text: chalk.cyan(token), nextFlag: false };
  if (token.startsWith('-')) return { text: chalk.yellow(token), nextFlag: true };
  if (previousWasFlag) return { text: chalk.green(token), nextFlag: false };
  return { text: token, nextFlag: false };
};

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
    const { text, nextFlag } = colorizeToken(tokens[index], index, previousWasFlag);
    coloredTokens.push(text);
    previousWasFlag = nextFlag;
  }

  return coloredTokens;
};

/**
 * Color a CLI command string using the shared help/example visual language.
 *
 * @param command - Full CLI command text
 * @returns ANSI-colored command string
 */
export const formatCliCommand = (command: string): string => formatCliCommandTokens(command).join(' ');
