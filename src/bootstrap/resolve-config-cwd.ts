import { ConfigurationError } from '../common/errors/app.error';
import { repoDirCandidates, resolveExistingRepoDir } from '../common/utils/repo-resolution';

const repoFlags = new Set(['-r', '--repos']);

const resolveOrThrow = (repo: string, currentCwd: string): string => {
  const resolved = resolveExistingRepoDir(repo, currentCwd);
  if (resolved) return resolved;

  const searched = repoDirCandidates(repo, currentCwd);
  throw new ConfigurationError(
    `Repository '${repo}' not found. Searched:\n${searched.map(p => `  - ${p}`).join('\n')}\n`
    + 'Use an absolute path, run from a parent/sibling directory, '
    + 'or set WF_REPOS_DIR to the directory containing your repositories.'
  );
};

const findRepoFlag = (argv: string[]): string | null => {
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (repoFlags.has(arg)) {
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
 * CWD-relative, CWD-sibling, or under a repos directory). Throws `ConfigurationError` if resolution
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
