import * as fs from 'fs';
import * as path from 'path';
import { resolveCustomArtifactDir, resolveRepoBasePath } from '../../agents/utils';

const artifactBasePathForSourceFallback = (repos?: string[]): string => resolveRepoBasePath(repos?.[0]);

/**
 * Resolve a custom markdown source using repo-aware local file rules.
 *
 * Filename-only sources prefer the targeted repo's `~/.wf/<repo>/` custom
 * artifact namespace when `--repos` is supplied.
 *
 * @param source - Raw `--custom-plan` CLI value
 * @param baseDir - Repo-aware base directory
 * @param repos - Optional repo list supplied via `--repos`
 * @returns Absolute or cwd-relative source path
 */
export const resolveCustomSourcePath = (source: string, baseDir: string, repos?: string[]): string => {
  if (path.isAbsolute(source)) {
    return source;
  }

  if (repos?.length && path.dirname(source) === '.') {
    const matches = (repos ?? [])
      .map(repo => path.join(resolveCustomArtifactDir(resolveRepoBasePath(repo)), source))
      .filter(candidate => fs.existsSync(candidate));

    if (matches.length > 1) {
      throw new Error(`Custom source "${source}" matches multiple repositories: ${matches.join(', ')}`);
    }

    if (matches.length === 1) {
      return matches[0];
    }
  }

  const cwdCandidate = path.resolve(source);
  if (fs.existsSync(cwdCandidate)) {
    return cwdCandidate;
  }

  if (path.dirname(source) === '.') {
    return path.join(resolveCustomArtifactDir(baseDir), source);
  }

  return path.resolve(artifactBasePathForSourceFallback(repos), source);
};
