import * as path from 'node:path';
import { walkDir, buildSkipDirs } from './walk-dir';

export interface ReuseCandidateContext {
  candidates: Array<{ name: string; relativePath: string }>;
}

const EXTRACT_MAX_CHARS = 5000;
const FORMAT_MAX_CHARS = 3000;
const MIN_TOKEN_LENGTH = 4;
const MIN_MATCH_TOKENS = 2;

const stopwords = new Set([
  'this', 'that', 'with', 'from', 'have', 'been', 'will', 'into', 'more',
  'some', 'then', 'than', 'they', 'them', 'when', 'make', 'does', 'also',
  'over', 'each', 'show', 'page', 'view', 'item', 'list', 'data', 'type',
  'file', 'code', 'test', 'spec', 'user', 'form', 'text', 'link', 'icon',
  'menu', 'card', 'section', 'content', 'layout', 'style', 'class', 'name',
  'base', 'main', 'core', 'util', 'utils', 'common', 'shared', 'service',
  'module', 'feature', 'ticket', 'update', 'create', 'delete', 'remove',
  'change', 'toggle', 'click', 'handle', 'event', 'adds',
]);

function tokenizeText(text: string): Set<string> {
  return new Set(
    text
      .slice(0, EXTRACT_MAX_CHARS)
      .toLowerCase()
      .split(/\W+/)
      .filter(t => t.length >= MIN_TOKEN_LENGTH && !stopwords.has(t)),
  );
}

function tokenizeFilename(filename: string): string[] {
  return filename
    .replace(/\.[^.]+$/, '')
    .split(/(?=[A-Z])|[-_]/)
    .map(t => t.toLowerCase())
    .filter(t => t.length >= MIN_TOKEN_LENGTH && !stopwords.has(t));
}

const UI_SCAN_DIRS = ['app/components', 'app/composables'];

function matchFileToTokens(
  filePath: string,
  repoDir: string,
  ticketTokens: Set<string>,
): { name: string; relativePath: string } | null {
  const name = path.basename(filePath);
  const matchCount = tokenizeFilename(name).filter(t => ticketTokens.has(t)).length;
  return matchCount >= MIN_MATCH_TOKENS ? { name, relativePath: path.relative(repoDir, filePath) } : null;
}

function scanDirForCandidates(
  absDir: string,
  repoDir: string,
  ticketTokens: Set<string>,
  skipDirs: Set<string>,
): Array<{ name: string; relativePath: string }> {
  try {
    return walkDir(absDir, () => true, skipDirs)
      .map(f => matchFileToTokens(f, repoDir, ticketTokens))
      .filter((c): c is { name: string; relativePath: string } => c !== null);
  } catch {
    return [];
  }
}

/**
 * Scans `app/components` and `app/composables` for files whose name tokens
 * significantly overlap the ticket content, returning them as reuse candidates.
 * Repos that place UI files under a different root (e.g. `src/components`) will
 * always receive `undefined`; extend `UI_SCAN_DIRS` for those layouts.
 */
export function detectReuseCandidates(
  repoDir: string,
  ticketContent: string,
): ReuseCandidateContext | undefined {
  const ticketTokens = tokenizeText(ticketContent);
  if (ticketTokens.size === 0) return undefined;
  const skipDirs = buildSkipDirs(repoDir);
  const candidates = UI_SCAN_DIRS.flatMap(scanDir =>
    scanDirForCandidates(path.join(repoDir, scanDir), repoDir, ticketTokens, skipDirs),
  );
  return candidates.length > 0 ? { candidates } : undefined;
}

/**
 * Formats detected reuse candidates as a prompt section string, capped at
 * `FORMAT_MAX_CHARS` characters to prevent context bloat.
 */
export function formatReuseCandidatesPromptSection(
  ctx: ReuseCandidateContext | undefined,
): string {
  if (!ctx?.candidates?.length) return '';
  const lines = [
    '- Existing components that may be reusable for this ticket (check before creating new ones):',
    ...ctx.candidates.map(c => `  - \`${c.relativePath}\` (${c.name})`),
  ].join('\n');
  if (lines.length <= FORMAT_MAX_CHARS) return lines;
  const cut = lines.lastIndexOf('\n', FORMAT_MAX_CHARS);
  return lines.slice(0, cut > 0 ? cut : FORMAT_MAX_CHARS);
}
