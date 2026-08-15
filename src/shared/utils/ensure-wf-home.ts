import * as fs from 'fs';
import chalk from 'chalk';
import inquirer from 'inquirer';
import { getWfHomeDir, getWfLogDir, getWfStateDir } from './wf-paths';
import { FileSystemError } from '../errors/app.error';

const throwWfHomeMissing = (wfHome: string, verb: 'does not exist' | 'is required'): never => {
  throw new FileSystemError(`The wf home directory (${wfHome}) ${verb}. Create it manually:\n\n  mkdir -p ${wfHome}/logs ${wfHome}/state`);
};

const requireInteractiveConfirmation = async (wfHome: string): Promise<void> => {
  if (!process.stdin.isTTY) throwWfHomeMissing(wfHome, 'does not exist');

  console.warn(chalk.yellow(`The wf home directory (${wfHome}) does not exist.`));
  const { confirm } = await inquirer.prompt<{ confirm: boolean }>([
    { type: 'confirm', name: 'confirm', message: 'Create it now?', prefix: ' ', default: true },
  ]);

  if (!confirm) throwWfHomeMissing(wfHome, 'is required');
};

export const ensureWfHome = async (): Promise<void> => {
  const wfHome = getWfHomeDir();
  if (fs.existsSync(wfHome)) return;

  await requireInteractiveConfirmation(wfHome);

  for (const dir of [wfHome, getWfLogDir(), getWfStateDir()]) {
    fs.mkdirSync(dir, { recursive: true });
  }
};
