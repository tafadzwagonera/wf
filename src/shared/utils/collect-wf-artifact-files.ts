import * as fs from 'fs';
import * as path from 'path';

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
  const collectedFilePaths: string[] = [];

  const visitDirectory = (currentDir: string): void => {
    let entries: fs.Dirent[];

    try {
      entries = fs.readdirSync(currentDir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const entryPath = path.join(currentDir, entry.name);

      if (entry.isDirectory()) {
        visitDirectory(entryPath);
        continue;
      }

      if (!entry.isFile()) {
        continue;
      }

      if (!includeFile(entryPath, entry.name)) {
        continue;
      }

      collectedFilePaths.push(entryPath);
    }
  };

  visitDirectory(rootDir);

  return collectedFilePaths;
};
