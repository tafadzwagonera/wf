import * as fs from 'node:fs';
import * as path from 'node:path';
import { getWfReposDirs } from './wf-paths';

const tokenCandidates = (token: string, cwd: string): string[] => [
  path.resolve(cwd, token),
  path.resolve(cwd, '..', token),
  ...getWfReposDirs().map(base => path.resolve(base, token)),
];

/**
 * List the directories probed for a `-r/--repos` token, in precedence order.
 *
 * The full token is tried against cwd, cwd's sibling, then each repos base. A multi-segment
 * token (`workspace/repo`) then retries its second segment through the same chain.
 *
 * @param repo - Repository token from `-r/--repos`
 * @param cwd - Directory that relative tokens and siblings resolve against
 * @returns Deduplicated absolute candidate paths
 */
export const repoDirCandidates = (repo: string, cwd: string): string[] => {
  const segment = path.isAbsolute(repo) ? undefined : repo.split('/').filter(Boolean)[1];
  const segmentCandidates = segment ? tokenCandidates(segment, cwd) : [];
  return [...new Set([...tokenCandidates(repo, cwd), ...segmentCandidates])];
};

/**
 * Resolve a `-r/--repos` token to an existing local directory.
 *
 * @param repo - Repository token from `-r/--repos`
 * @param cwd - Directory that relative tokens and siblings resolve against
 * @returns First existing candidate, or null when none exists
 */
export const resolveExistingRepoDir = (repo: string, cwd: string): string | null =>
  repoDirCandidates(repo, cwd).find(candidate => fs.existsSync(candidate)) ?? null;
