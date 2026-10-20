import * as fs from 'node:fs';
import * as path from 'node:path';
import * as YAML from 'yaml';
import { resolveArtifactDir, resolveCustomArtifactDir } from '../../agents/utils';
import { deriveReviewArtifactPath, stripSupportedPlanExtension, supportedPlanExtensions } from './plan-artifact';
import { readDirEntries } from './read-dir-entries';
import type { PlanArtifactFormat } from '../types/plan-artifact.types';

/**
 * Resolve the file path for a code review artifact.
 * @param repoBaseDir - Base directory of the repository
 * @param trackerName - Tracker namespace (e.g., 'jira', 'bitbucket')
 * @param ticketKey - Ticket identifier (e.g., 'WBP-123')
 * @param format - Review artifact format; defaults to markdown
 * @returns Absolute path to the review artifact
 */
export const resolveReviewArtifactPath = (
  repoBaseDir: string,
  trackerName: string,
  ticketKey: string,
  format: PlanArtifactFormat = 'md'
): string => {
  const ticketPath = path.join(resolveArtifactDir(repoBaseDir, trackerName), `${ticketKey}.md`);
  return deriveReviewArtifactPath(ticketPath, undefined, format);
};

export const resolveCustomReviewArtifactPath = (
  repoBaseDir: string, planStem: string, format: PlanArtifactFormat = 'md'
): string =>
  deriveReviewArtifactPath(path.join(resolveCustomArtifactDir(repoBaseDir), `${planStem}.md`), undefined, format);

/**
 * List every format variant of a review artifact path, one per supported extension.
 * @param reviewPath - Review artifact path in any supported format
 * @returns Candidate paths sharing the stem of `reviewPath`
 */
export const listReviewArtifactVariants = (reviewPath: string): string[] => {
  const stem = stripSupportedPlanExtension(reviewPath);
  return supportedPlanExtensions.map(extension => `${stem}.${extension}`);
};

/**
 * Find the review artifact on disk regardless of the format it was written in.
 * @param reviewPath - Review artifact path in any supported format
 * @returns The existing variant's path, or null when none exists
 */
export const findExistingReviewArtifact = (reviewPath: string): string | null =>
  listReviewArtifactVariants(reviewPath).find(candidate => fs.existsSync(candidate)) ?? null;

export interface FallbackReviewArtifactMatch {
  artifactPath: string;
  alternates: string[];
}

const datePrefixPattern = '\\d{4}-\\d{2}-\\d{2}-';

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const listTokenReviewMatches = (dir: string, pattern: RegExp): string[] =>
  readDirEntries(dir)
    .filter(entry => (entry.isFile() || entry.isSymbolicLink()) && pattern.test(entry.name))
    .map(entry => path.join(dir, entry.name));

const sortByMtimeDesc = (paths: string[]): string[] => {
  const stamped = paths.flatMap(candidate => {
    try {
      return [{ candidate, mtimeMs: fs.statSync(candidate).mtimeMs }];
    } catch {
      return [];
    }
  });
  return stamped
    .sort((a, b) => b.mtimeMs - a.mtimeMs || a.candidate.localeCompare(b.candidate))
    .map(({ candidate }) => candidate);
};

/**
 * Find review artifacts named `YYYY-MM-DD-<token>-review.<ext>` in the tracker and custom artifact directories.
 * Limitations: scope-suffixed multi-repo artifacts (`<token>-<repo>-review.<ext>`) are excluded, and matching here
 * is case-insensitive whereas the exact-path `existsSync` probe is filesystem-dependent.
 * @param repoBaseDir - Base directory of the repository
 * @param trackerName - Tracker namespace (e.g., 'jira')
 * @param token - Exact review stem without date prefix or extension
 * @returns The newest match and its alternates, or null when nothing matches
 */
export const findDatePrefixedReviewArtifact = (
  repoBaseDir: string,
  trackerName: string,
  token: string
): FallbackReviewArtifactMatch | null => {
  const extensions = supportedPlanExtensions.join('|');
  const pattern = new RegExp(
    `^${datePrefixPattern}${escapeRegExp(token)}-review\\.(?:${extensions})$`,
    'i'
  );
  const dirs = [resolveArtifactDir(repoBaseDir, trackerName), resolveCustomArtifactDir(repoBaseDir)];
  const sorted = sortByMtimeDesc(dirs.flatMap(dir => listTokenReviewMatches(dir, pattern)));
  return sorted.length === 0 ? null : { artifactPath: sorted[0], alternates: sorted.slice(1) };
};

const extractStructuredSummary = (value: unknown): string | null => {
  const [firstTarget] = Array.isArray(value) ? value : [value];
  const summary = (firstTarget as { review?: { summary?: unknown } } | undefined)?.review?.summary;
  return typeof summary === 'string' && summary.trim().length > 0 ? summary.trim() : null;
};

const extractTextSummary = (content: string): string | null => {
  const m = /^## Summary\n([\s\S]*?)\n\n## Issues/m.exec(content) || /^SUMMARY:\n([\s\S]*?)\n(?:APPROVAL STATUS|ISSUES[\s:])/m.exec(content);
  if (!m) return null;
  const summary = m[1].trim();
  return summary.length > 0 ? summary : null;
};

/**
 * Read and extract the summary from a code review artifact.
 * Handles markdown and standalone cache text formats, plus JSON and YAML cache artifacts.
 * @returns Trimmed summary text, or null if file missing, unreadable, or malformed
 * @param artifactPath
 */
export const readReviewArtifactSummary = (artifactPath: string): string | null => {
  if (!fs.existsSync(artifactPath)) return null;
  try {
    const content = fs.readFileSync(artifactPath, 'utf-8');
    const extension = path.extname(artifactPath).slice(1).toLowerCase();
    if (extension === 'json') return extractStructuredSummary(JSON.parse(content));
    if (extension === 'yaml' || extension === 'yml') return extractStructuredSummary(YAML.parse(content));
    return extractTextSummary(content);
  } catch {
    return null;
  }
};
