// src/agents/utils.ts
import * as fs from 'fs';
import * as path from 'path';
import chalk from 'chalk';
import { getWfHomeDir } from '../shared/utils/wf-paths';

/**
 * Resolve the artifact storage directory for a given platform.
 *
 * @param baseDir - Base directory for artifact storage (repo path)
 * @param platformName - The platform name (e.g. 'jira', 'bitbucket')
 * @returns Absolute path to the platform artifact directory under `~/.wf/<app>/`
 */
export const resolveArtifactDir = (
  baseDir: string,
  platformName: string,
): string =>
  path.join(getWfHomeDir(), path.basename(path.resolve(baseDir)), platformName);

/**
 * Extract the ticket summary from a markdown ticket file.
 * Matches headings of the form: "# TICKET-123: Summary text"
 *
 * @param content - Raw markdown content of the ticket file
 * @returns The summary text, or 'Implementation' if no match found
 */
export const extractSummary = (content: string): string => {
  const match = content.match(/^#\s+[A-Z]+-\d+:\s+(.+)$/m);
  return match ? match[1] : 'Implementation';
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
    chalk.yellow(
      `⚠  Repository '${repo}' not found as a path or sibling directory. Using current directory.`,
    ),
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
