// src/agents/utils.ts
import * as fs from 'fs';
import * as path from 'path';
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
  const keyedMatch = content.match(/^#\s+[A-Z]+-\d+:\s+(.+)$/m);
  if (keyedMatch) return keyedMatch[1];

  const headingMatch = content.match(/^#\s+(.+)$/m);
  if (headingMatch) return headingMatch[1];

  return 'Implementation';
};

/**
 * Convert a string to a URL-safe slug.
 * Lowercases, strips non-word characters, collapses spaces to hyphens,
 * deduplicates hyphens, and strips leading/trailing hyphens.
 *
 * @param text - Input string to slugify
 * @returns URL-safe slug
 */
/**
 * Resolve the base directory for a repository.
 * Tries: absolute path → relative to cwd → sibling of cwd → falls back to cwd.
 *
 * @param repo - Repository name or path (e.g. "bar", "../bar", "/abs/path/bar")
 * @returns Absolute path to use as the artifact storage base directory
 */
export const resolveRepoBasePath = (repo?: string): string => {
  if (!repo) return process.cwd();

  const tryResolvePath = (candidate: string): string | null => {
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

  const resolvedRepoPath = tryResolvePath(repo);
  if (resolvedRepoPath) {
    return resolvedRepoPath;
  }

  const repoSegments = repo.split(/\//).filter(Boolean);
  const localRepoName = repoSegments.length > 1 ? repoSegments[1] : null;
  if (localRepoName) {
    const resolvedRepoNamePath = tryResolvePath(localRepoName);
    if (resolvedRepoNamePath) {
      return resolvedRepoNamePath;
    }
  }

  console.log(
    chalk.yellow(`⚠️ Repository '${repo}' not found as a path or sibling directory. Using current directory.`)
  );
  return process.cwd();
};

export const slugify = (text: string): string =>
  text
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');

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
