import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import chalk from 'chalk';
import { runPostPullDependencyInstall } from './post-pull-install';
import { detectPackageManager } from './detect-repo-conventions';

const VERIFY_SCRIPT_NAMES = ['lint', 'typecheck', 'test'];

const availableVerifyCommands = (repoDir: string, pm: string): string[] => {
  const pkgPath = path.join(repoDir, 'package.json');
  if (!fs.existsSync(pkgPath)) return [];
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8')) as { scripts?: Record<string, string> };
    const scripts = pkg.scripts ?? {};
    return VERIFY_SCRIPT_NAMES
      .filter(name => name in scripts)
      .map(name => `${pm} run ${name}`);
  } catch {
    return [];
  }
};

const runVerifyCommand = (command: string, repoDir: string): { command: string; failed: boolean } => {
  try {
    execSync(command, { cwd: repoDir, stdio: 'ignore' });
    return { command, failed: false };
  } catch {
    return { command, failed: true };
  }
};

export const runPreReviewVerification = async (
  repoDir: string, options: { silent?: boolean } = {}
): Promise<string> => {
  await runPostPullDependencyInstall(repoDir);
  const pm = detectPackageManager(repoDir);
  const commands = availableVerifyCommands(repoDir, pm);
  if (commands.length === 0) return '';
  if (!options.silent) console.log(chalk.gray(`  Running pre-review verification (${pm})...`));
  const results = commands.map(cmd => runVerifyCommand(cmd, repoDir));
  const lines = results.map(r => `  ${r.failed ? '✗' : '✓'} ${r.command}`);
  return `Pre-review verification:\n${lines.join('\n')}`;
};
