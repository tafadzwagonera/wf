import * as fs from 'node:fs';
import * as path from 'node:path';
import { readDirEntries } from './read-dir-entries';

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

const parseGitignoreLine = (raw: string): string | null => {
  const line = raw.trim();
  if (!line || line.startsWith('#') || line.startsWith('!')) return null;
  if (line.includes('*') || line.includes('?')) return null;
  if (line.endsWith('/')) {
    const name = line.slice(0, -1);
    return name.includes('/') ? null : name;
  }
  return line.includes('/') ? null : line;
};

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
  let content: string;
  try {
    content = fs.readFileSync(gitignorePath, 'utf-8') || '';
  } catch {
    return new Set();
  }
  const names = content.split('\n').map(parseGitignoreLine).filter((n): n is string => n !== null);
  return new Set(names);
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
): string[] =>
  readDirEntries(dir).flatMap(entry => {
    const fullPath = path.join(dir, entry.name);
    if (!entry.isDirectory()) return predicate(fullPath) ? [fullPath] : [];
    return skipDirs.has(entry.name) ? [] : walkDir(fullPath, predicate, skipDirs);
  });
