import { execSync } from 'node:child_process';
import chalk from 'chalk';
import { installDependencies } from './install-dependencies';

const readChangedFiles = (repoDir: string): string[] => {
  try {
    const out = execSync('git diff --name-only HEAD@{1} HEAD', {
      cwd: repoDir, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'],
    });
    return out.split('\n').map(f => f.trim());
  } catch {
    return [];
  }
};

export const runPostPullDependencyInstall = async (repoDir: string): Promise<void> => {
  if (!readChangedFiles(repoDir).includes('package.json')) return;
  console.log(chalk.gray('  package.json changed — installing dependencies...'));
  const result = await installDependencies(repoDir);
  if (!result.success) {
    console.log(chalk.yellow(`  ⚠ ${result.warning}`));
    return;
  }
  console.log(chalk.gray(`  ✔ Dependencies updated via ${result.packageManager}`));
};
