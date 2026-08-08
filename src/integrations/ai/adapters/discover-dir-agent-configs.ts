import * as fs from 'node:fs';
import * as path from 'node:path';
import type { WfAiProviderName } from '../../../shared/types/config.types';
import type { FileEntry } from '../../../shared/types/ai.types';

export const PROVIDER_CONFIG_FILENAMES: Record<WfAiProviderName, string> = {
  anthropic: 'CLAUDE.md',
  openai: 'AGENTS.md',
  google: 'GEMINI.md',
  deepseek: 'DEEPSEEK.md',
};

const collectDirectories = (filePaths: string[]): Set<string> => {
  const dirs = new Set<string>();
  for (const filePath of filePaths) {
    const dir = path.dirname(filePath);
    if (dir.split('/').length > 1) dirs.add(dir);
  }
  return dirs;
};

const findExistingConfigs = (
  dirs: Set<string>,
  configFilename: string,
  repoBaseDir: string,
): FileEntry[] => {
  const found: FileEntry[] = [];
  for (const dir of dirs) {
    const candidatePath = path.join(dir, configFilename);
    if (fs.existsSync(path.join(repoBaseDir, candidatePath))) {
      found.push({ filePath: candidatePath, status: 'found' });
    }
  }
  return found;
};

export const discoverDirAgentConfigs = (
  filePaths: string[],
  providerName: WfAiProviderName,
  repoBaseDir: string,
): FileEntry[] => {
  if (filePaths.length === 0) return [];
  const dirs = collectDirectories(filePaths);
  const found = findExistingConfigs(dirs, PROVIDER_CONFIG_FILENAMES[providerName], repoBaseDir);
  found.sort((a, b) => {
    const depthDiff = b.filePath.split('/').length - a.filePath.split('/').length;
    return depthDiff !== 0 ? depthDiff : a.filePath.localeCompare(b.filePath);
  });
  return found;
};
