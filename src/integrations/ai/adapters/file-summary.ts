import chalk from 'chalk';

/**
 * Prints the end-of-run file summary shared by the CLI and SDK adapters: a sorted list of
 * updated files, agent-declared no-change files, or a note that the run made no file changes.
 */
export const logFileSummary = (touchedFiles: Set<string>, notApplicableFiles: Set<string> = new Set()): void => {
  const declaredOnly = [...notApplicableFiles].filter(f => !touchedFiles.has(f));
  if (touchedFiles.size === 0 && declaredOnly.length === 0) {
    console.log(chalk.gray('\n  File summary: no file changes were made.'));
    return;
  }
  console.log(chalk.bold('\n  File summary:'));
  for (const f of [...touchedFiles].sort((a, b) => a.localeCompare(b))) {
    console.log(chalk.cyan(`    - updated: ${f}`));
  }
  for (const f of declaredOnly.sort((a, b) => a.localeCompare(b))) {
    console.log(chalk.cyan(`    - no change required (agent-declared): ${f}`));
  }
};
