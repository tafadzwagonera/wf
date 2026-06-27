import type { CodeIssue, CodeReview } from '../integrations/ai/ai.service';
import type { CodeReviewPresentation, ProcessedCodeReview } from '../shared/types/review.types';

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
  let currentFile: string | null = null;
  let currentDestinationLine: number | null = null;

  for (const line of diff.split('\n')) {
    const diffHeaderMatch = line.match(DIFF_HEADER_PATTERN);
    if (diffHeaderMatch) {
      currentFile = normalizeFilePath(diffHeaderMatch[2]);
      currentDestinationLine = null;
      continue;
    }

    const destinationFileMatch = line.match(DESTINATION_FILE_PATTERN);
    if (destinationFileMatch) {
      const destinationFilePath = destinationFileMatch[1]?.trim();
      currentFile =
        destinationFilePath && destinationFilePath !== '/dev/null' ? normalizeFilePath(destinationFilePath) : null;
      currentDestinationLine = null;
      continue;
    }

    const hunkHeaderMatch = line.match(HUNK_HEADER_PATTERN);
    if (hunkHeaderMatch) {
      const startLine = Number.parseInt(hunkHeaderMatch[1] ?? '', 10);
      const lineCount = hunkHeaderMatch[2] ? Number.parseInt(hunkHeaderMatch[2], 10) : 1;
      currentDestinationLine = startLine;

      if (currentFile) {
        const hunkEnd = startLine + Math.max(lineCount - 1, 0);
        const existing = hunkSpansByFile.get(currentFile);
        if (existing) {
          existing.first = Math.min(existing.first, startLine);
          existing.last = Math.max(existing.last, hunkEnd);
        } else {
          hunkSpansByFile.set(currentFile, {
            first: startLine,
            last: hunkEnd,
          });
        }
      }
      continue;
    }

    if (currentFile == null || currentDestinationLine == null) {
      continue;
    }

    if (line.startsWith('+') && !line.startsWith('+++')) {
      addChangedLine(changedLinesByFile, currentFile, currentDestinationLine, line.slice(1));
      currentDestinationLine += 1;
      continue;
    }

    if (line.startsWith('-') && !line.startsWith('---')) {
      continue;
    }

    if (line.startsWith(' ')) {
      currentDestinationLine += 1;
    }
  }

  const result = new Map<string, DiffFileInfo>();
  for (const [filePath, changedLines] of changedLinesByFile) {
    const span = hunkSpansByFile.get(filePath);
    result.set(filePath, {
      changedLines: [...changedLines].sort((left, right) => left.line - right.line),
      hunkSpanFirst: span?.first ?? changedLines[0]?.line ?? 0,
      hunkSpanLast: span?.last ?? changedLines[changedLines.length - 1]?.line ?? 0,
    });
  }

  return result;
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
    if (inlineCode) {
      anchors.add(inlineCode);
    }
  }

  for (const match of text.matchAll(ENVIRONMENT_TOKEN_PATTERN)) {
    const token = match[0]?.trim();
    if (token) {
      anchors.add(token);
    }
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
  issue: CodeIssue,
  changedLines: ChangedDestinationLine[],
  anchors: string[]
): number | null => {
  if (anchors.length === 0) {
    return null;
  }

  const scoredChangedLines = changedLines.map(changedLine => ({
    changedLine,
    score: scoreChangedLineAgainstIssue(changedLine, anchors),
  }));
  const bestMatch = scoredChangedLines.reduce(
    (best, candidate) =>
      candidate.score > best.score
        ? candidate
        : candidate.score === best.score && candidate.changedLine.line < best.changedLine.line
          ? candidate
          : best,
    {
      changedLine: changedLines[0],
      score: scoreChangedLineAgainstIssue(changedLines[0], anchors),
    }
  );
  if (bestMatch.score === 0) {
    return null;
  }

  const rawLineScore =
    typeof issue.line === 'number'
      ? (scoredChangedLines.find(({ changedLine }) => changedLine.line === issue.line)?.score ?? 0)
      : 0;

  return bestMatch.score > rawLineScore ? bestMatch.changedLine.line : null;
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

  return {
    ...review,
    issues: review.issues.map(issue => {
      if (!issue.file) {
        return issue;
      }

      const fileInfo = diffInfoByFile.get(normalizeFilePath(issue.file));
      if (!fileInfo?.changedLines.length) {
        return {
          ...issue,
          line: undefined,
        };
      }

      const { changedLines, hunkSpanFirst, hunkSpanLast } = fileInfo;

      const anchors = extractIssueAnchors(`${issue.message} ${issue.suggestion ?? ''}`);

      const semanticLine = resolveSemanticIssueLine(issue, changedLines, anchors);
      if (semanticLine != null) {
        return {
          ...issue,
          line: semanticLine,
        };
      }

      if (anchors.length > 0) {
        const maxScore = changedLines.reduce(
          (best, cl) => Math.max(best, scoreChangedLineAgainstIssue(cl, anchors)),
          0
        );
        if (maxScore === 0) {
          const withinHunkSpan =
            typeof issue.line === 'number' && issue.line >= hunkSpanFirst && issue.line <= hunkSpanLast;

          if (!withinHunkSpan) {
            return { ...issue, line: undefined };
          }
        }
      }

      if (typeof issue.line !== 'number' || !Number.isFinite(issue.line) || issue.line <= 0) {
        return {
          ...issue,
          line: undefined,
        };
      }

      return {
        ...issue,
        line: normalizeIssueLine(
          issue.line,
          changedLines.map(changedLine => changedLine.line)
        ),
      };
    }),
  };
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

  return {
    review: normalizedReview,
    presentation: buildCodeReviewPresentation(normalizedReview),
  };
};
