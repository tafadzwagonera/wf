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

export const discoverDirAgentConfigs = (
  filePaths: string[],
  providerName: WfAiProviderName,
  repoBaseDir: string,
): FileEntry[] => {
  if (filePaths.length === 0) return [];

  const configFilename = PROVIDER_CONFIG_FILENAMES[providerName];
  const dirs = new Set<string>();

  for (const filePath of filePaths) {
    const dir = path.dirname(filePath);
    const segments = dir.split('/');
    const isRepoRoot = segments.length <= 1;
    if (!isRepoRoot) dirs.add(dir);
  }

  const found: FileEntry[] = [];

  for (const dir of dirs) {
    const candidatePath = path.join(dir, configFilename);
    if (fs.existsSync(path.join(repoBaseDir, candidatePath))) {
      found.push({ filePath: candidatePath, status: 'found' });
    }
  }

  found.sort((a, b) => {
    const depthA = a.filePath.split('/').length;
    const depthB = b.filePath.split('/').length;
    if (depthB !== depthA) return depthB - depthA;
    return a.filePath.localeCompare(b.filePath);
  });

  return found;
};
