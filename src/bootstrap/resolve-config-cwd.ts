import * as fs from 'node:fs';
import * as path from 'node:path';
import { ConfigurationError } from '../shared/errors/app.error';

const REPO_FLAGS = new Set(['-r', ' --repos']);

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

const resolveExistingRepoDir = (repo: string): string | null => {
  const repoDir = resolvePath(repo);
  if (repoDir) {
    return repoDir;
  }

  const repoSegments = repo.split(/\//).filter(Boolean);
  const localRepoName = repoSegments.length > 1 ? repoSegments[1] : null;
  return localRepoName ? resolvePath(localRepoName) : null;
};

const resolveOrThrow = (repo: string, currentCwd: string): string => {
  const resolved = resolveExistingRepoDir(repo);
  if (resolved) return resolved;

  const searched = [...new Set([
    path.resolve(currentCwd, repo),
    path.resolve(currentCwd, '..', repo),
  ])];
  throw new ConfigurationError(
    `Repository '${repo}' not found. Searched:\n${searched.map(p => `  - ${p}`).join('\n')}\nUse an absolute path or run from a parent/sibling directory.`
  );
};

const findRepoFlag = (argv: string[]): string | null => {
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (REPO_FLAGS.has(arg)) {
      const repo = argv[index + 1];
      if (repo && !repo.startsWith('-')) return repo;
      continue;
    }
    if (arg.startsWith('--repos=')) {
      const repo = arg.slice('--repos='.length);
      if (repo) return repo;
    }
  }
  return null;
};

/**
 * Resolve the config cwd to use during CLI bootstrap.
 *
 * When `-r`/`--repos` is provided, the repo must resolve locally (absolute,
 * CWD-relative, or CWD-sibling). Throws `ConfigurationError` if resolution
 * fails — the user explicitly requested that repo's config.
 *
 * @param argv - Raw CLI argv values
 * @returns Consumer repo root when --repos/-r resolves locally, else current cwd
 * @throws ConfigurationError when -r/--repos is provided but the repo cannot be found
 */
export const resolveConfigCwd = (argv: string[]): string => {
  const currentCwd = process.cwd();
  const repo = findRepoFlag(argv);
  return repo ? resolveOrThrow(repo, currentCwd) : currentCwd;
};
