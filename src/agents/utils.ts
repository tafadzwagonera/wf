import * as fs from 'node:fs';
import * as path from 'node:path';
import { execSync } from 'node:child_process';
import chalk from 'chalk';
import { resolveExistingRepoDir } from '../common/utils/repo-resolution';
import { getWfHomeDir } from '../common/utils/wf-paths';
import { GitError } from '../common/utils/errors';

export const resolveArtifactDir = (baseDir: string, trackerName: string): string =>
  path.join(getWfHomeDir(), path.basename(path.resolve(baseDir)), trackerName);

export const resolveCustomArtifactDir = (baseDir: string): string =>
  path.join(getWfHomeDir(), path.basename(path.resolve(baseDir)));

export const extractSummary = (content: string): string => {
  const keyedMatch = /^#\s+[A-Z]+-\d+:\s+(.+)$/m.exec(content);
  if (keyedMatch) return keyedMatch[1];

  const headingMatch = /^#\s+(.+)$/m.exec(content);
  if (headingMatch) return headingMatch[1];

  return 'Implementation';
};

export const resolveRepoBasePath = (repo?: string): string => {
  if (!repo) return process.cwd();

  const resolved = resolveExistingRepoDir(repo, process.cwd());
  if (resolved) return resolved;

  console.log(
    chalk.yellow(
      `⚠ Repository '${repo}' not found as a path, sibling directory, or under any repos directory. `
      + 'Using current directory.'
    )
  );
  return process.cwd();
};

export const toRepoKeys = (repos: (string | undefined)[]): string[] => {
  const resolved = repos.map(repo => resolveRepoBasePath(repo));
  const pathsByBasename = new Map<string, Set<string>>();
  for (const repoPath of resolved) {
    const basename = path.basename(repoPath);
    pathsByBasename.set(basename, (pathsByBasename.get(basename) ?? new Set()).add(repoPath));
  }
  return resolved.map(repoPath => {
    const basename = path.basename(repoPath);
    return (pathsByBasename.get(basename)?.size ?? 0) > 1 ? repoPath : basename;
  });
};

export const isRepoResolvable = (repo: string): boolean => resolveExistingRepoDir(repo, process.cwd()) !== null;

export const scaffoldNewRepo = (repo: string, baseDir: string): string => {
  const repoPath = path.resolve(baseDir, '..', repo);
  fs.mkdirSync(repoPath, { recursive: true });
  execSync('git init', { cwd: repoPath, stdio: 'pipe' });
  try {
    execSync('git commit --allow-empty -m "chore: initial commit"', { cwd: repoPath, stdio: 'pipe' });
  } catch {
    throw new GitError(`scaffoldNewRepo: git commit failed in ${repoPath}. Ensure git user.name and user.email are configured.`, { repoPath });
  }
  return repoPath;
};

export const slugify = (text: string): string =>
  text
    .toLowerCase()
    .replaceAll(/[^\w\s-]/g, '')
    .replaceAll(/\s+/g, '-')
    .replaceAll(/-+/g, '-')
    .replaceAll(/(^-+)|(-+$)/g, '');

export const MAX_BRANCH_NAME_LENGTH = 100;

export const truncateSlug = (slug: string, prefixLength: number): string => {
  const maxSlugLength = MAX_BRANCH_NAME_LENGTH - prefixLength;
  if (slug.length <= maxSlugLength) return slug;
  if (maxSlugLength <= 0) return '';

  const truncated = slug.substring(0, maxSlugLength);
  const lastHyphen = truncated.lastIndexOf('-');
  return lastHyphen > 0 ? truncated.substring(0, lastHyphen) : truncated;
};
