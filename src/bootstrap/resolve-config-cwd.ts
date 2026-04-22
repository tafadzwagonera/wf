import * as fs from 'fs';
import * as path from 'path';

const REPO_FLAGS = new Set(['-r', '--repos']);

const resolveExistingRepoDir = (repo: string): string | null => {
  const resolvePath = (candidate: string): string | null => {
    if (path.isAbsolute(candidate) && fs.existsSync(candidate)) {
      return candidate;
    }

    const relPath = path.resolve(process.cwd(), candidate);
    if (fs.existsSync(relPath)) {
      return relPath;
    }

    const siblingPath = path.resolve(process.cwd(), '..', candidate);
    if (fs.existsSync(siblingPath)) {
      return siblingPath;
    }

    return null;
  };

  const repoDir = resolvePath(repo);
  if (repoDir) {
    return repoDir;
  }

  const repoSegments = repo.split(/\//).filter(Boolean);
  const localRepoName = repoSegments.length > 1 ? repoSegments[1] : null;
  return localRepoName ? resolvePath(localRepoName) : null;
};

/**
 * Resolve the config cwd to use during CLI bootstrap.
 *
 * This lookup is intentionally silent: config bootstrap may need to inspect a
 * sibling repository when it exists locally, but remote-only workflows should
 * not warn merely because no checkout is present.
 *
 * @param argv - Raw CLI argv values
 * @returns Consumer repo root when --repos/-r resolves locally, else current cwd
 */
export const resolveConfigCwd = (argv: string[]): string => {
  const currentCwd = process.cwd();

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (REPO_FLAGS.has(arg)) {
      const repo = argv[index + 1];
      if (repo && !repo.startsWith('-')) {
        return resolveExistingRepoDir(repo) ?? currentCwd;
      }
      continue;
    }

    if (arg.startsWith('--repos=')) {
      const repo = arg.slice('--repos='.length);
      if (repo) {
        return resolveExistingRepoDir(repo) ?? currentCwd;
      }
    }
  }

  return currentCwd;
};
