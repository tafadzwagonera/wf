import * as fs from 'node:fs';
import * as path from 'node:path';
import { resolveArtifactDir } from '../../agents/utils';
import { deriveReviewArtifactPath } from './plan-artifact';

/**
 * Resolve the file path for a code review artifact.
 * @param repoBaseDir - Base directory of the repository
 * @param trackerName - Tracker namespace (e.g., 'jira', 'bitbucket')
 * @param ticketKey - Ticket identifier (e.g., 'WBP-123')
 * @returns Absolute path to the review artifact
 */
export const resolveReviewArtifactPath = (
  repoBaseDir: string,
  trackerName: string,
  ticketKey: string
): string => {
  const ticketPath = path.join(resolveArtifactDir(repoBaseDir, trackerName), `${ticketKey}.md`);
  return deriveReviewArtifactPath(ticketPath);
};

/**
 * Read and extract the summary from a code review artifact.
 * Handles both full-workflow markdown format and standalone cache text format.
 * @returns Trimmed summary text, or null if file missing, unreadable, or malformed
 * @param path
 */
export const readReviewArtifactSummary = (path: string): string | null => {
  if (!fs.existsSync(path)) return null;
  try {
    const content = fs.readFileSync(path, 'utf-8');
    const m = /^## Summary\n([\s\S]*?)\n\n## Issues/m.exec(content) || /^SUMMARY:\n([\s\S]*?)\n(?:APPROVAL STATUS|ISSUES[\s:])/m.exec(content);
    if (!m) return null;
    const summary = m[1].trim();
    return summary.length > 0 ? summary : null;
  } catch {
    return null;
  }
};
