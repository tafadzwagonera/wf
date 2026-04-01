import chalk from 'chalk';

export interface CliExample {
  comment: string;
  command: string;
}

/**
 * Print color-coded usage examples in --help output.
 *
 * @param examples - Array of CLI examples to display
 */
export const printExamples = (examples: CliExample[]): void => {
  examples.forEach((example) => {
    // Print comment line
    console.log(chalk.gray(`  # ${example.comment}`));

    // Color-code the command
    const tokens = example.command.split(' ');
    const coloredTokens: string[] = [];
    let previousWasFlag = false;

    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i];

      // Rule 1: 'wf' at start → cyan
      if (i === 0 && token === 'wf') {
        coloredTokens.push(chalk.cyan('wf'));
        previousWasFlag = false;
        continue;
      }

      // Rule 2: Token starts with '-' → yellow flag
      if (token.startsWith('-')) {
        coloredTokens.push(chalk.yellow(token));
        previousWasFlag = true;
        continue;
      }

      // Rule 3: Non-flag token following a flag → green value
      if (previousWasFlag) {
        coloredTokens.push(chalk.green(token));
        previousWasFlag = false;
        continue;
      }

      // Rule 4: Any other token (subcommand, positional args) → plain white
      coloredTokens.push(token);
      previousWasFlag = false;
    }

    // Print colored command line
    console.log(`  ${coloredTokens.join(' ')}`);

    // Blank line after each example
    console.log('');
  });
};
