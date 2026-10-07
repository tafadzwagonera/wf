import chalk from 'chalk';

/**
 * Prints the end-of-run file summary shared by the CLI and SDK adapters: a sorted list of
 * updated files, or a note that the run made no file changes.
 */
export const logFileSummary = (touchedFiles: Set<string>): void => {
  if (touchedFiles.size === 0) {
    console.log(chalk.gray('\n  File summary: no file changes were made.'));
    return;
  }
  console.log(chalk.bold('\n  File summary:'));
  for (const f of [...touchedFiles].sort((a, b) => a.localeCompare(b))) {
    console.log(chalk.cyan(`    - updated: ${f}`));
  }
};
