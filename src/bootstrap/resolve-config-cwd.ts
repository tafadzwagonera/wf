import { resolveRepoBasePath } from '../agents/utils';

const REPO_FLAGS = new Set(['-r', '--repos']);

/**
 * Resolve the config cwd to use during CLI bootstrap.
 *
 * @param argv - Raw CLI argv values
 * @returns Consumer repo root when --repos/-r is present, else current cwd
 */
export const resolveConfigCwd = (argv: string[]): string => {
  const currentCwd = process.cwd();

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (REPO_FLAGS.has(arg)) {
      const repo = argv[index + 1];
      if (repo && !repo.startsWith('-')) {
        return resolveRepoBasePath(repo);
      }
      continue;
    }

    if (arg.startsWith('--repos=')) {
      const repo = arg.slice('--repos='.length);
      if (repo) {
        return resolveRepoBasePath(repo);
      }
    }
  }

  return currentCwd;
};
