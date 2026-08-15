import { execSync } from 'child_process';
import chalk from 'chalk';
import { installDependencies } from './install-dependencies';

export const runPostPullDependencyInstall = async (repoDir: string): Promise<void> => {
  let changed: string;
  try {
    changed = execSync('git diff --name-only HEAD@{1} HEAD', {
      cwd: repoDir, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return;
  }
  if (!changed.split('\n').some(f => f.trim() === 'package.json')) return;

  console.log(chalk.gray('  package.json changed — installing dependencies...'));
  const result = await installDependencies(repoDir);
  if (!result.success) {
    console.log(chalk.yellow(`  ⚠ ${result.warning}`));
    return;
  }
  console.log(chalk.gray(`  ✔ Dependencies updated via ${result.packageManager}`));
};
