import * as fs from 'fs';
import * as path from 'path';
import { resolveCustomArtifactDir } from '../../agents/utils';
import { AppError } from '../errors/app.error';

/**
 * Resolve a custom markdown source from the artifact repository (`~/.wf/<repo>/`).
 *
 * Relative sources resolve inside the custom artifact namespace of `baseDir`,
 * which callers derive from the first `--repos` value.
 *
 * @param source - Raw `--custom-plan` CLI value
 * @param baseDir - Repo-aware base directory
 * @returns Absolute path within the artifact repository
 */
export const resolveCustomSourcePath = (source: string, baseDir: string): string => {
  if (path.isAbsolute(source)) {
    if (!fs.existsSync(source)) throw new AppError('FILE_SYSTEM_ERROR', `Custom source not found: ${source}`);
    return source;
  }
  const artifactCandidate = path.join(resolveCustomArtifactDir(baseDir), source);
  if (fs.existsSync(artifactCandidate)) return artifactCandidate;
  throw new AppError('FILE_SYSTEM_ERROR', `Custom source "${source}" not found in artifact repository: ${artifactCandidate}`);
};
