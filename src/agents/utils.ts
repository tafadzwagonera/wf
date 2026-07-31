import * as fs from 'node:fs';
import * as path from 'node:path';
import { execSync } from 'node:child_process';
import chalk from 'chalk';
import { getWfHomeDir } from '../shared/utils/wf-paths';

/**
 * Resolve the artifact storage directory for a given tracker.
 *
 * @param baseDir - Base directory for artifact storage (repo path)
 * @param trackerName - The tracker name (e.g. 'jira', 'bitbucket')
 * @returns Absolute path to the tracker artifact directory under `~/.wf/<app>/`
 */
export const resolveArtifactDir = (baseDir: string, trackerName: string): string =>
  path.join(getWfHomeDir(), path.basename(path.resolve(baseDir)), trackerName);

/**
 * Resolve the repository-scoped artifact directory used for custom artifacts.
 *
 * @param baseDir - Base directory for artifact storage (repo path)
 * @returns Absolute path to the custom artifact directory under `~/.wf/<app>/`
 */
export const resolveCustomArtifactDir = (baseDir: string): string =>
  path.join(getWfHomeDir(), path.basename(path.resolve(baseDir)));

/**
 * Extract the ticket summary from a markdown ticket file.
 * Matches headings of the form: "# TICKET-123: Summary text"
 *
 * @param content - Raw markdown content of the ticket file
 * @returns The summary text, or 'Implementation' if no match found
 */
export const extractSummary = (content: string): string => {
  const keyedMatch = /^#\s+[A-Z]+-\d+:\s+(.+)$/m.exec(content);
  if (keyedMatch) return keyedMatch[1];

  const headingMatch = /^#\s+(.+)$/m.exec(content);
  if (headingMatch) return headingMatch[1];

  return 'Implementation';
};

const tryResolvePath = (candidate: string): string | null => {
  if (path.isAbsolute(candidate) && fs.existsSync(candidate)) return candidate;

  const relPath = path.resolve(process.cwd(), candidate);
  if (fs.existsSync(relPath)) return relPath;

  const siblingPath = path.resolve(process.cwd(), '..', candidate);
  if (fs.existsSync(siblingPath)) return siblingPath;

  return null;
};

const tryResolveSegmentFallback = (repo: string): string | null => {
  const segments = repo.split(/\//).filter(Boolean);
  const localRepoName = segments.length > 1 ? segments[1] : null;
  return localRepoName ? tryResolvePath(localRepoName) : null;
};

/**
 * Resolve the base directory for a repository.
 * Tries: absolute path → relative to cwd → sibling of cwd → falls back to cwd.
 *
 * @param repo - Repository name or path (e.g. "bar", "../bar", "/abs/path/bar")
 * @returns Absolute path to use as the artifact storage base directory
 */
export const resolveRepoBasePath = (repo?: string): string => {
  if (!repo) return process.cwd();

  const resolved = tryResolvePath(repo) ?? tryResolveSegmentFallback(repo);
  if (resolved) return resolved;

  console.log(
    chalk.yellow(`⚠️ Repository '${repo}' not found as a path or sibling directory. Using current directory.`)
  );
  return process.cwd();
};

/**
 * Check whether a repository name resolves to an existing local directory.
 *
 * @param repo - Repository name or path to check
 * @returns True if the repo resolves to an existing directory
 */
export const isRepoResolvable = (repo: string): boolean =>
  (tryResolvePath(repo) ?? tryResolveSegmentFallback(repo)) !== null;

/**
 * Scaffold a new repository as a sibling of the given base directory.
 * Creates the directory, runs `git init`, and creates an initial empty commit
 * so that branch operations work immediately.
 *
 * @param repo - Repository name to scaffold
 * @param baseDir - Base directory whose parent will contain the new repo
 * @returns Absolute path to the scaffolded repository
 */
export const scaffoldNewRepo = (repo: string, baseDir: string): string => {
  const repoPath = path.resolve(baseDir, '..', repo);
  fs.mkdirSync(repoPath, { recursive: true });
  execSync('git init', { cwd: repoPath, stdio: 'pipe' });
  try {
    execSync('git commit --allow-empty -m "chore: initial commit"', { cwd: repoPath, stdio: 'pipe' });
  } catch {
    throw new Error(`scaffoldNewRepo: git commit failed in ${repoPath}. Ensure git user.name and user.email are configured.`);
  }
  return repoPath;
};

/**
 * Convert a string to a URL-safe slug.
 * Lowercases, strips non-word characters, collapses spaces to hyphens,
 * deduplicates hyphens, and strips leading/trailing hyphens.
 *
 * @param text - Input string to slugify
 * @returns URL-safe slug
 */
export const slugify = (text: string): string =>
  text
    .toLowerCase()
    .replaceAll(/[^\w\s-]/g, '')
    .replaceAll(/\s+/g, '-')
    .replaceAll(/-+/g, '-')
    .replaceAll(/(^-+)|(-+$)/g, '');

export const MAX_BRANCH_NAME_LENGTH = 100;

/**
 * Truncate a slug to fit within a max total branch name length.
 * Cuts at the last word boundary (hyphen) before the limit.
 *
 * @param slug - The slugified summary portion
 * @param prefixLength - Characters already consumed by prefix + ticket key + separators
 * @returns Truncated slug; empty string when prefixLength >= MAX_BRANCH_NAME_LENGTH
 */
export const truncateSlug = (slug: string, prefixLength: number): string => {
  const maxSlugLength = MAX_BRANCH_NAME_LENGTH - prefixLength;
  if (slug.length <= maxSlugLength) return slug;
  if (maxSlugLength <= 0) return '';

  const truncated = slug.substring(0, maxSlugLength);
  const lastHyphen = truncated.lastIndexOf('-');
  return lastHyphen > 0 ? truncated.substring(0, lastHyphen) : truncated;
};
