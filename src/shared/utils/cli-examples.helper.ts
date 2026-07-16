import chalk from 'chalk';
import { formatCliCommand } from './cli-command-colors';
import type { CliExample } from '../types/bootstrap.types';

export type { CliExample };

/**
 * Print color-coded usage examples in --help output.
 *
 * @param examples - Array of CLI examples to display
 */
export const printExamples = (examples: CliExample[]): void => {
  for (const example of examples) {
    // Print comment line
    console.log(chalk.gray(`  # ${example.comment}`));

    // Print colored command line
    console.log(`  ${formatCliCommand(example.command)}`);

    // Blank line after each example
    console.log('');
  }
};
