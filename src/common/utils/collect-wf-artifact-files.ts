import * as fs from 'fs';
import * as path from 'path';

const readDirEntries = (dir: string): fs.Dirent[] => {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch { return []; }
};

function visitDirectory(
  currentDir: string,
  includeFile: (filePath: string, fileName: string) => boolean,
  collected: string[]
): void {
  for (const entry of readDirEntries(currentDir)) {
    const entryPath = path.join(currentDir, entry.name);
    if (entry.isDirectory()) {
      visitDirectory(entryPath, includeFile, collected);
    } else if (entry.isFile() && includeFile(entryPath, entry.name)) {
      collected.push(entryPath);
    }
  }
}

/**
 * Recursively collect artifact file paths from a repo-scoped wf directory.
 * Unreadable directories are skipped so higher-level discovery can stay non-throwing.
 *
 * @param rootDir - Directory to scan recursively
 * @param includeFile - Predicate used to decide whether a file path should be collected
 * @returns Matching file paths under rootDir
 */
export const collectWfArtifactFiles = (
  rootDir: string,
  includeFile: (filePath: string, fileName: string) => boolean
): string[] => {
  const collected: string[] = [];
  visitDirectory(rootDir, includeFile, collected);
  return collected;
};
