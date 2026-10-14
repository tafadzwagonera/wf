import type { ResolutionPlan } from '../types/ai.types';

/**
 * Normalizes an affectedFiles entry to a plain file path string.
 *
 * @param entry - Either a string path or a FileEntry object
 * @returns The file path string
 */
export const toFilePath = (entry: string | { filePath: string }): string =>
  typeof entry === 'string' ? entry : entry.filePath;

/**
 * Builds a set of planned file paths with repo prefixes stripped.
 *
 * @param affectedFiles - The plan's declared affected files
 * @param affectedRepositories - Repository names used to strip path prefixes
 * @returns Set of repo-relative file paths
 */
export const buildPlannedPathSet = (
  affectedFiles: NonNullable<ResolutionPlan['affectedFiles']>,
  affectedRepositories: string[]
): Set<string> => {
  const strip = (p: string): string => {
    const match = affectedRepositories.find(repo => p.startsWith(`${repo}/`));
    return match ? p.slice(match.length + 1) : p;
  };
  return new Set(affectedFiles.map(entry => strip(toFilePath(entry))));
};
