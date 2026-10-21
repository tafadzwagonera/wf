import chalk from 'chalk';
import { installDependencies } from './install-dependencies';

export const runPostPullDependencyInstall = async (
  repoDir: string,
  skip?: boolean,
  silent?: boolean
): Promise<void> => {
  if (skip) return;
  const result = await installDependencies(repoDir);
  if (!result.success) {
    console.log(chalk.yellow(`  ⚠ ${result.warning}`));
    return;
  }
  if (result.skipped || silent) return;
  console.log(chalk.gray(`  ✔ Dependencies updated via ${result.packageManager}`));
};
