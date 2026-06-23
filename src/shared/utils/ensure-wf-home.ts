import * as fs from 'fs';
import chalk from 'chalk';
import inquirer from 'inquirer';
import { getWfHomeDir, getWfLogDir, getWfStateDir } from './wf-paths';

/**
 * Ensure the wf home directory (~/.wf) and its subdirectories exist.
 *
 * When `~/.wf` is missing and a TTY is available, prompts the user
 * to create it interactively. Throws when the directory cannot be
 * created (no TTY or user declines).
 */
export const ensureWfHome = async (): Promise<void> => {
  const wfHome = getWfHomeDir();

  if (fs.existsSync(wfHome)) {
    return;
  }

  if (!process.stdin.isTTY) {
    throw new Error(
      `The wf home directory (${wfHome}) does not exist. Create it manually:\n\n  mkdir -p ${wfHome}/logs ${wfHome}/state`,
    );
  }

  console.warn(
    chalk.yellow(`The wf home directory (${wfHome}) does not exist.`),
  );

  const { confirm } = await inquirer.prompt<{ confirm: boolean }>([
    {
      type: 'confirm',
      name: 'confirm',
      message: 'Create it now?',
      prefix: ' ',
      default: true,
    },
  ]);

  if (!confirm) {
    throw new Error(
      `The wf home directory (${wfHome}) is required. Create it manually:\n\n  mkdir -p ${wfHome}/logs ${wfHome}/state`,
    );
  }

  for (const dir of [wfHome, getWfLogDir(), getWfStateDir()]) {
    fs.mkdirSync(dir, { recursive: true });
  }
};
