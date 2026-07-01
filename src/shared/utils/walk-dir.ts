import * as fs from 'fs';
import * as path from 'path';

export const DEFAULT_SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'coverage',
  '.next',
  '.turbo',
  '.cache',
  '.output',
  '.nuxt',
  '.svelte-kit',
  '.parcel-cache',
  'out',
  '.tsbuildinfo',
]);

/**
 * Parse a `.gitignore` file and extract directory names to skip.
 *
 * Only bare directory patterns are extracted (e.g. `logs/`, `tmp`). Negated
 * patterns, wildcards, and path-separator patterns are ignored — they require
 * full glob matching which is out of scope for a lightweight skip set.
 *
 * @param gitignorePath - Absolute path to the `.gitignore` file
 * @returns Set of directory names parsed from the file
 */
export const parseGitignore = (gitignorePath: string): Set<string> => {
  const dirs = new Set<string>();

  let content: string | undefined;
  try {
    content = fs.readFileSync(gitignorePath, 'utf-8');
  } catch {
    return dirs;
  }

  if (!content) return dirs;

  for (const raw of content.split('\n')) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#') || line.startsWith('!')) continue;
    // Skip patterns with wildcards or path separators — too complex for a name set
    if (line.includes('*') || line.includes('?')) continue;
    if (line.includes('/') && line !== line.replace(/\/$/, '')) {
      // "dirname/" — trailing slash only, no embedded separators
      const name = line.replace(/\/$/, '');
      if (!name.includes('/')) dirs.add(name);
      continue;
    }
    if (line.includes('/')) continue;
    // Bare name without trailing slash — could be a file or directory; include it
    dirs.add(line);
  }

  return dirs;
};

/**
 * Build the full skip set: default directories merged with `.gitignore` entries.
 *
 * @param repoDir - Absolute path to the repository root (used to locate `.gitignore`)
 * @returns Combined set of directory names to skip
 */
export const buildSkipDirs = (repoDir: string): Set<string> => {
  const gitignoreDirs = parseGitignore(path.join(repoDir, '.gitignore'));
  return new Set([...DEFAULT_SKIP_DIRS, ...gitignoreDirs]);
};

/**
 * Recursively walk a directory collecting file paths that match a predicate.
 *
 * @param dir - Absolute directory path to walk
 * @param predicate - Function returning true for paths to include
 * @param skipDirs - Set of directory names to skip (defaults to `DEFAULT_SKIP_DIRS`)
 * @returns Array of matching absolute file paths
 */
export const walkDir = (
  dir: string,
  predicate: (filePath: string) => boolean,
  skipDirs: Set<string> = DEFAULT_SKIP_DIRS
): string[] => {
  const results: string[] = [];

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return results;
  }

  for (const entry of entries) {
    if (entry.isDirectory() && skipDirs.has(entry.name)) continue;
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...walkDir(fullPath, predicate, skipDirs));
    } else if (predicate(fullPath)) {
      results.push(fullPath);
    }
  }

  return results;
};
