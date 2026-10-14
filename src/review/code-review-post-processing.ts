import type { CodeIssue, CodeReview } from '../integrations/ai/ai.service';
import type { CodeReviewPresentation, ProcessedCodeReview } from '../shared/types/review.types';
import { deriveApproval } from './derive-approval';

export type {
  ReviewPresentationIssueRow,
  CodeReviewPresentation,
  ProcessedCodeReview,
} from '../shared/types/review.types';

interface ChangedDestinationLine {
  line: number;
  content: string;
}

interface DiffFileInfo {
  changedLines: ChangedDestinationLine[];
  hunkSpanFirst: number;
  hunkSpanLast: number;
}

const DIFF_HEADER_PATTERN = /^diff --git a\/(.+?) b\/(.+?)(?:\s|$)/;
const DESTINATION_FILE_PATTERN = /^\+\+\+\s+(.*)$/;
const HUNK_HEADER_PATTERN = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/;
const INLINE_CODE_PATTERN = /`([^`]+)`/g;
const ENVIRONMENT_TOKEN_PATTERN = /\b[A-Z][A-Z0-9_]{2,}\b/g;

interface DiffParseState {
  currentFile: string | null;
  currentDestinationLine: number | null;
}

/**
 * Normalize a diff or review file path so review issues can be matched to
 * destination-side unified diff file entries.
 *
 * @param filePath - Diff or review file path
 * @returns Comparable file path without diff-specific prefixes
 */
const normalizeFilePath = (filePath: string): string => filePath.replace(/^[ab]\//, '').trim();

/**
 * Record a changed destination-side line against a file path.
 *
 * @param changedLinesByFile - File-to-line map under construction
 * @param filePath - Destination-side diff path
 * @param line - Changed destination-side line number
 * @returns Nothing
 */
const addChangedLine = (
  changedLinesByFile: Map<string, ChangedDestinationLine[]>,
  filePath: string,
  line: number,
  content: string
): void => {
  const normalizedPath = normalizeFilePath(filePath);
  const changedLines = changedLinesByFile.get(normalizedPath) ?? [];
  changedLines.push({ line, content });
  changedLinesByFile.set(normalizedPath, changedLines);
};

const processDiffHeaderLine = (line: string, state: DiffParseState): boolean => {
  const match = DIFF_HEADER_PATTERN.exec(line);
  if (!match) return false;
  state.currentFile = normalizeFilePath(match[2]);
  state.currentDestinationLine = null;
  return true;
};

const processDestinationFileLine = (line: string, state: DiffParseState): boolean => {
  const match = DESTINATION_FILE_PATTERN.exec(line);
  if (!match) return false;
  const dest = match[1]?.trim();
  state.currentFile = dest && dest !== '/dev/null' ? normalizeFilePath(dest) : null;
  state.currentDestinationLine = null;
  return true;
};

const updateHunkSpan = (
  hunkSpansByFile: Map<string, { first: number; last: number }>,
  filePath: string, startLine: number, hunkEnd: number
): void => {
  const existing = hunkSpansByFile.get(filePath);
  if (existing) {
    existing.first = Math.min(existing.first, startLine);
    existing.last = Math.max(existing.last, hunkEnd);
  } else {
    hunkSpansByFile.set(filePath, { first: startLine, last: hunkEnd });
  }
};

const processHunkHeaderLine = (
  line: string, state: DiffParseState, hunkSpansByFile: Map<string, { first: number; last: number }>
): boolean => {
  const match = HUNK_HEADER_PATTERN.exec(line);
  if (!match) return false;
  const startLine = Number.parseInt(match[1] ?? '', 10);
  const lineCount = match[2] ? Number.parseInt(match[2], 10) : 1;
  state.currentDestinationLine = startLine;
  if (state.currentFile) {
    updateHunkSpan(hunkSpansByFile, state.currentFile, startLine, startLine + Math.max(lineCount - 1, 0));
  }
  return true;
};

const processContentLine = (
  line: string, state: DiffParseState, changedLinesByFile: Map<string, ChangedDestinationLine[]>
): void => {
  if (state.currentFile == null || state.currentDestinationLine == null) return;
  if (line.startsWith('+') && !line.startsWith('+++')) {
    addChangedLine(changedLinesByFile, state.currentFile, state.currentDestinationLine, line.slice(1));
    state.currentDestinationLine += 1;
    return;
  }
  if (line.startsWith('-') && !line.startsWith('---')) return;
  if (line.startsWith(' ')) state.currentDestinationLine += 1;
};

const buildDiffFileInfoMap = (
  changedLinesByFile: Map<string, ChangedDestinationLine[]>,
  hunkSpansByFile: Map<string, { first: number; last: number }>
): Map<string, DiffFileInfo> => {
  const result = new Map<string, DiffFileInfo>();
  for (const [filePath, changedLines] of changedLinesByFile) {
    const span = hunkSpansByFile.get(filePath);
    result.set(filePath, {
      changedLines: [...changedLines].sort((left, right) => left.line - right.line),
      hunkSpanFirst: span?.first ?? changedLines[0]?.line ?? 0,
      hunkSpanLast: span?.last ?? changedLines.at(-1)?.line ?? 0,
    });
  }
  return result;
};

/**
 * Parse unified diff content into destination-side changed line numbers and
 * hunk boundary spans per file.
 *
 * @param diff - Raw unified diff
 * @returns Diff file info keyed by normalized file path
 */
const collectDiffFileInfo = (diff: string): Map<string, DiffFileInfo> => {
  const changedLinesByFile = new Map<string, ChangedDestinationLine[]>();
  const hunkSpansByFile = new Map<string, { first: number; last: number }>();
  const state: DiffParseState = { currentFile: null, currentDestinationLine: null };
  for (const line of diff.split('\n')) {
    if (processDiffHeaderLine(line, state)) continue;
    if (processDestinationFileLine(line, state)) continue;
    if (processHunkHeaderLine(line, state, hunkSpansByFile)) continue;
    processContentLine(line, state, changedLinesByFile);
  }
  return buildDiffFileInfoMap(changedLinesByFile, hunkSpansByFile);
};

/**
 * Map a model-provided line to the nearest valid destination-side changed line.
 *
 * @param modelLine - Raw line from the review issue
 * @param changedLines - Valid changed destination-side lines for the file
 * @returns Preserved or normalized line number
 */
const normalizeIssueLine = (modelLine: number, changedLines: number[]): number => {
  if (changedLines.includes(modelLine)) {
    return modelLine;
  }

  return changedLines.reduce((nearestLine, candidateLine) => {
    const nearestDistance = Math.abs(nearestLine - modelLine);
    const candidateDistance = Math.abs(candidateLine - modelLine);

    if (candidateDistance < nearestDistance) {
      return candidateLine;
    }

    return candidateDistance === nearestDistance && candidateLine < nearestLine ? candidateLine : nearestLine;
  });
};

/**
 * Extract high-signal anchors from issue text so a changed line can be
 * matched to the referenced code or environment variable.
 *
 * @param text - Concatenated issue message and suggestion text
 * @returns Unique anchors ordered from strongest to weakest signal
 */
const extractIssueAnchors = (text: string): string[] => {
  const anchors = new Set<string>();

  for (const match of text.matchAll(INLINE_CODE_PATTERN)) {
    const inlineCode = match[1]?.trim();
    if (inlineCode) anchors.add(inlineCode);
  }

  for (const match of text.matchAll(ENVIRONMENT_TOKEN_PATTERN)) {
    const token = match[0]?.trim();
    if (token) anchors.add(token);
  }

  return [...anchors];
};

/**
 * Score how strongly a changed line matches the issue text.
 *
 * @param changedLine - Changed line candidate
 * @param anchors - Extracted issue anchors
 * @returns Relative semantic match score
 */
const scoreChangedLineAgainstIssue = (changedLine: ChangedDestinationLine, anchors: string[]): number => {
  return anchors.reduce((score, anchor) => {
    if (!anchor) {
      return score;
    }

    if (anchor.includes(' ') || anchor.includes('"') || anchor.includes('$')) {
      return changedLine.content.includes(anchor) ? score + 10 : score;
    }

    return changedLine.content.includes(anchor) ? score + 3 : score;
  }, 0);
};

type ScoredLine = { changedLine: ChangedDestinationLine; score: number };

const findBestScoredLine = (scored: ScoredLine[]): ScoredLine =>
  scored.reduce((best, candidate) => {
    if (candidate.score > best.score) return candidate;
    if (candidate.score === best.score && candidate.changedLine.line < best.changedLine.line) return candidate;
    return best;
  });

/**
 * Prefer a semantically matching changed line when the issue message clearly
 * points at a different changed line than the model-selected line.
 *
 * @param issue - Review issue under normalization
 * @param changedLines - Changed destination-side lines with source text
 * @param anchors - Pre-computed anchors extracted from the issue
 * @returns Better matching changed line or null when no stronger match exists
 */
const resolveSemanticIssueLine = (
  issue: CodeIssue, changedLines: ChangedDestinationLine[], anchors: string[]
): number | null => {
  if (anchors.length === 0) return null;
  const scored = changedLines.map(changedLine => ({
    changedLine,
    score: scoreChangedLineAgainstIssue(changedLine, anchors),
  }));
  const bestMatch = findBestScoredLine(scored);
  if (bestMatch.score === 0) return null;
  const rawLineScore = typeof issue.line === 'number'
    ? (scored.find(({ changedLine }) => changedLine.line === issue.line)?.score ?? 0)
    : 0;
  return bestMatch.score > rawLineScore ? bestMatch.changedLine.line : null;
};

/**
 * @param originalLine - Model-provided start line before normalization
 * @param normalizedLine - Start line after normalization (may be undefined)
 * @param endLine - Model-provided end line
 * @returns Adjusted endLine or undefined when the range is no longer valid
 */
const alignEndLine = (
  originalLine: number | undefined,
  normalizedLine: number | undefined,
  endLine: number | undefined
): number | undefined => {
  if (normalizedLine === undefined || typeof endLine !== 'number') return undefined;
  if (originalLine !== normalizedLine) return undefined;
  return endLine > normalizedLine ? endLine : undefined;
};

const isOutsideHunkSpan = (
  issue: CodeIssue, changedLines: ChangedDestinationLine[], anchors: string[],
  hunkSpanFirst: number, hunkSpanLast: number
): boolean => {
  const maxScore = changedLines.reduce((best, cl) => Math.max(best, scoreChangedLineAgainstIssue(cl, anchors)), 0);
  if (maxScore > 0) return false;
  return typeof issue.line !== 'number' || issue.line < hunkSpanFirst || issue.line > hunkSpanLast;
};

const hasUsableIssueLine = (
  issue: CodeIssue, anchors: string[], fileInfo: DiffFileInfo
): issue is CodeIssue & { line: number } => {
  const { changedLines, hunkSpanFirst, hunkSpanLast } = fileInfo;
  const outsideHunk = anchors.length > 0
    && isOutsideHunkSpan(issue, changedLines, anchors, hunkSpanFirst, hunkSpanLast);
  return !outsideHunk && typeof issue.line === 'number' && Number.isFinite(issue.line) && issue.line > 0;
};

const normalizeIssue = (issue: CodeIssue, diffInfoByFile: Map<string, DiffFileInfo>): CodeIssue => {
  if (!issue.file) return issue;
  const fileInfo = diffInfoByFile.get(normalizeFilePath(issue.file));
  if (!fileInfo?.changedLines.length) return { ...issue, line: undefined, endLine: undefined };
  const { changedLines } = fileInfo;
  const anchors = extractIssueAnchors(`${issue.message} ${issue.suggestion ?? ''}`);
  const semanticLine = resolveSemanticIssueLine(issue, changedLines, anchors);
  if (semanticLine != null) {
    return { ...issue, line: semanticLine, endLine: alignEndLine(issue.line, semanticLine, issue.endLine) };
  }
  if (!hasUsableIssueLine(issue, anchors, fileInfo)) return { ...issue, line: undefined, endLine: undefined };
  const normalized = normalizeIssueLine(issue.line, changedLines.map(cl => cl.line));
  return { ...issue, line: normalized, endLine: alignEndLine(issue.line, normalized, issue.endLine) };
};

/**
 * Normalize review issue lines against changed destination-side diff lines.
 *
 * @param review - Parsed code review payload
 * @param diff - Raw unified diff used for the review
 * @returns Review with issue lines aligned to destination-side diff anchors
 */
const normalizeReviewIssues = (review: CodeReview, diff: string): CodeReview => {
  const diffInfoByFile = collectDiffFileInfo(diff);
  return { ...review, issues: review.issues.map(issue => normalizeIssue(issue, diffInfoByFile)) };
};

/**
 * Build issue-local presentation rows and unmatched trailing suggestions.
 *
 * @param review - Review payload to present
 * @returns Presentation data shared by CLI and workflow renderers
 */
export const buildCodeReviewPresentation = (review: CodeReview): CodeReviewPresentation => ({
  issueRows: review.issues.map(issue => ({
    issue,
    suggestion: issue.suggestion,
  })),
  unmatchedSuggestions: review.suggestions,
});

/**
 * Normalize review issues against the diff and derive shared presentation data.
 *
 * @param review - Parsed code review payload
 * @param diff - Raw unified diff used for the review
 * @returns Normalized review plus shared presentation metadata
 */
export const postProcessCodeReview = (review: CodeReview, diff: string): ProcessedCodeReview => {
  const normalizedReview = normalizeReviewIssues(review, diff);
  const approved = deriveApproval(normalizedReview.issues, normalizedReview.approved);
  const derivedReview = { ...normalizedReview, approved };

  return {
    review: derivedReview,
    presentation: buildCodeReviewPresentation(derivedReview),
  };
};
