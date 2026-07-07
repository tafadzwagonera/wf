import * as fs from 'fs';
import * as path from 'path';
import { resolveCustomArtifactDir, resolveRepoBasePath } from '../../agents/utils';
import { AppError } from '../errors/app.error';

/**
 * Resolve a custom markdown source from the artifact repository (`~/.wf/<app>/`).
 *
 * Filename-only sources prefer the targeted repo's `~/.wf/<repo>/` custom
 * artifact namespace when `--repos` is supplied.
 *
 * @param source - Raw `--custom-plan` CLI value
 * @param baseDir - Repo-aware base directory
 * @param repos - Optional repo list supplied via `--repos`
 * @returns Absolute path within the artifact repository
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
      throw new AppError(
        'FILE_SYSTEM_ERROR',
        `Custom source "${source}" matches multiple repositories: ${matches.join(', ')}`
      );
    }

    if (matches.length === 1) {
      return matches[0];
    }
  }

  const artifactDir = resolveCustomArtifactDir(baseDir);
  const artifactCandidate = path.join(artifactDir, source);
  if (fs.existsSync(artifactCandidate)) {
    return artifactCandidate;
  }

  throw new AppError(
    'FILE_SYSTEM_ERROR',
    `Custom source "${source}" not found in artifact repository: ${artifactCandidate}`
  );
};
