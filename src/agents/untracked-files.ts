import * as fs from 'node:fs';
import * as path from 'node:path';
import type { GitService } from '../integrations/git/git.service';
import { appendToLogFile } from '../common/logger/log-file-writer';

const NUL_SNIFF_BYTES = 8_192;
const LOG_CONTEXT = 'untracked-files';

export type UntrackedFile = { path: string; content: string; binary?: boolean };

export const readUntrackedFile = (repoDir: string, file: string): UntrackedFile => {
  const buffer = fs.readFileSync(path.resolve(repoDir, file));
  const binary = buffer.subarray(0, NUL_SNIFF_BYTES).includes(0);
  const content = binary ? `[binary file, ${buffer.length} bytes]` : buffer.toString('utf-8');
  return { path: file, content, binary };
};

const listUntrackedPaths = async (gitService: GitService, repoDir: string): Promise<string[]> => {
  try {
    const status = await gitService.getStatus(repoDir);
    return (status as { not_added?: string[] }).not_added ?? [];
  } catch (error) {
    appendToLogFile('DEBUG', `untracked.status-failed cause=${error instanceof Error ? error.message : String(error)}`, LOG_CONTEXT);
    return [];
  }
};

export const collectUntrackedFiles = async (gitService: GitService, repoDir: string): Promise<UntrackedFile[]> => {
  const files: UntrackedFile[] = [];
  for (const file of await listUntrackedPaths(gitService, repoDir)) {
    try {
      files.push(readUntrackedFile(repoDir, file));
    } catch {
      appendToLogFile('DEBUG', `untracked.unreadable path=${file}`, LOG_CONTEXT);
    }
  }
  return files;
};
