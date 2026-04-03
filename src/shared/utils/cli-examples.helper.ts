import chalk from 'chalk';
import { formatCliCommand } from './cli-command-colors';

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

    // Print colored command line
    console.log(`  ${formatCliCommand(example.command)}`);

    // Blank line after each example
    console.log('');
  });
};
