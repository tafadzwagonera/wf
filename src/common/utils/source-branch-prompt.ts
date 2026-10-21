import inquirer from 'inquirer';
import chalk from 'chalk';

/**
 * True when `branch` names a remote-tracking ref (e.g. `origin/develop`, `remotes/origin/develop`)
 * rather than a local branch. Shared so the implementer's upstream check and this prompt's
 * choice styling agree on what counts as remote.
 *
 * @param branch - Branch name to classify
 * @returns True when `branch` is remote-tracking
 */
export const isRemoteBranch = (branch: string): boolean =>
  branch.startsWith('remotes/') || branch.startsWith('origin/');

const formatSourceBranchChoice = (branch: string): { name: string; value: string } => ({
  name: isRemoteBranch(branch) ? chalk.gray(branch) : chalk.cyan(branch),
  value: branch,
});

/**
 * Prompts the user to disambiguate a source branch from multiple candidates. Shared between
 * the implementer's branch-creation workflow and the review command's legacy-manifest backfill
 * so both surfaces resolve ambiguity the same way.
 *
 * @param devBranches - Detected development branch candidates (must be non-empty)
 * @param mainBranch - Detected main/master branch, offered as an additional choice
 * @returns The branch the user selected
 */
export const promptForSourceBranch = async (devBranches: string[], mainBranch?: string): Promise<string> => {
  const choices = [
    ...devBranches.map(formatSourceBranchChoice),
    ...(mainBranch ? [formatSourceBranchChoice(mainBranch)] : []),
  ];
  const { selected } = await inquirer.prompt<{ selected: string }>([{
    type: 'list',
    name: 'selected',
    message: 'Multiple dev branches found. Select source branch:',
    prefix: ' ',
    choices,
    default: devBranches[0],
  }]);
  return selected;
};
