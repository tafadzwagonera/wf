import type { CodeIssue, CodeReview } from '../integrations/ai/ai.service';

export interface ReviewPresentationIssueRow {
  issue: CodeIssue;
  suggestion?: string;
}

export interface CodeReviewPresentation {
  issueRows: ReviewPresentationIssueRow[];
  unmatchedSuggestions: string[];
}

export interface ProcessedCodeReview {
  review: CodeReview;
  presentation: CodeReviewPresentation;
}

interface ChangedDestinationLine {
  line: number;
  content: string;
}

const DIFF_HEADER_PATTERN = /^diff --git a\/(.+?) b\/(.+?)(?:\s|$)/;
const DESTINATION_FILE_PATTERN = /^\+\+\+\s+(.*)$/;
const HUNK_HEADER_PATTERN = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/;
const INLINE_CODE_PATTERN = /`([^`]+)`/g;
const ENVIRONMENT_TOKEN_PATTERN = /\b[A-Z][A-Z0-9_]{2,}\b/g;

/**
 * Normalize a diff or review file path so review issues can be matched to
 * destination-side unified diff file entries.
 *
 * @param filePath - Diff or review file path
 * @returns Comparable file path without diff-specific prefixes
 */
const normalizeFilePath = (filePath: string): string =>
  filePath.replace(/^[ab]\//, '').trim();

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
  content: string,
): void => {
  const normalizedPath = normalizeFilePath(filePath);
  const changedLines = changedLinesByFile.get(normalizedPath) ?? [];
  changedLines.push({ line, content });
  changedLinesByFile.set(normalizedPath, changedLines);
};

/**
 * Parse unified diff content into destination-side changed line numbers per
 * file so review issues can be anchored to valid inline-comment locations.
 *
 * @param diff - Raw unified diff
 * @returns Destination-side changed lines keyed by normalized file path
 */
const collectChangedDestinationLines = (
  diff: string,
): Map<string, ChangedDestinationLine[]> => {
  const changedLinesByFile = new Map<string, ChangedDestinationLine[]>();
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
        destinationFilePath && destinationFilePath !== '/dev/null'
          ? normalizeFilePath(destinationFilePath)
          : null;
      currentDestinationLine = null;
      continue;
    }

    const hunkHeaderMatch = line.match(HUNK_HEADER_PATTERN);
    if (hunkHeaderMatch) {
      currentDestinationLine = Number.parseInt(hunkHeaderMatch[1] ?? '', 10);
      continue;
    }

    if (currentFile == null || currentDestinationLine == null) {
      continue;
    }

    if (line.startsWith('+') && !line.startsWith('+++')) {
      addChangedLine(
        changedLinesByFile,
        currentFile,
        currentDestinationLine,
        line.slice(1),
      );
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

  return new Map(
    [...changedLinesByFile.entries()].map(([filePath, changedLines]) => [
      filePath,
      [...changedLines].sort((left, right) => left.line - right.line),
    ]),
  );
};

/**
 * Map a model-provided line to the nearest valid destination-side changed line.
 *
 * @param modelLine - Raw line from the review issue
 * @param changedLines - Valid changed destination-side lines for the file
 * @returns Preserved or normalized line number
 */
const normalizeIssueLine = (
  modelLine: number,
  changedLines: number[],
): number => {
  if (changedLines.includes(modelLine)) {
    return modelLine;
  }

  return changedLines.reduce((nearestLine, candidateLine) => {
    const nearestDistance = Math.abs(nearestLine - modelLine);
    const candidateDistance = Math.abs(candidateLine - modelLine);

    if (candidateDistance < nearestDistance) {
      return candidateLine;
    }

    return candidateDistance === nearestDistance && candidateLine < nearestLine
      ? candidateLine
      : nearestLine;
  });
};

/**
 * Extract high-signal anchors from an issue message so a changed line can be
 * matched to the referenced code or environment variable.
 *
 * @param message - Issue message text
 * @returns Unique anchors ordered from strongest to weakest signal
 */
const extractIssueAnchors = (message: string): string[] => {
  const anchors = new Set<string>();

  for (const match of message.matchAll(INLINE_CODE_PATTERN)) {
    const inlineCode = match[1]?.trim();
    if (inlineCode) {
      anchors.add(inlineCode);
    }
  }

  for (const match of message.matchAll(ENVIRONMENT_TOKEN_PATTERN)) {
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
const scoreChangedLineAgainstIssue = (
  changedLine: ChangedDestinationLine,
  anchors: string[],
): number => {
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
 * @returns Better matching changed line or null when no stronger match exists
 */
const resolveSemanticIssueLine = (
  issue: CodeIssue,
  changedLines: ChangedDestinationLine[],
): number | null => {
  const anchors = extractIssueAnchors(issue.message);
  if (anchors.length === 0) {
    return null;
  }

  const scoredChangedLines = changedLines.map((changedLine) => ({
    changedLine,
    score: scoreChangedLineAgainstIssue(changedLine, anchors),
  }));
  const bestMatch = scoredChangedLines.reduce(
    (best, candidate) =>
      candidate.score > best.score
        ? candidate
        : candidate.score === best.score &&
            candidate.changedLine.line < best.changedLine.line
          ? candidate
          : best,
    {
      changedLine: changedLines[0],
      score: scoreChangedLineAgainstIssue(changedLines[0], anchors),
    },
  );
  if (bestMatch.score === 0) {
    return null;
  }

  const rawLineScore =
    typeof issue.line === 'number'
      ? (scoredChangedLines.find(
          ({ changedLine }) => changedLine.line === issue.line,
        )?.score ?? 0)
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
const normalizeReviewIssues = (
  review: CodeReview,
  diff: string,
): CodeReview => {
  const changedLinesByFile = collectChangedDestinationLines(diff);

  return {
    ...review,
    issues: review.issues.map((issue) => {
      if (!issue.file) {
        return issue;
      }

      const changedLines = changedLinesByFile.get(
        normalizeFilePath(issue.file),
      );
      if (!changedLines?.length) {
        return {
          ...issue,
          line: undefined,
        };
      }

      const semanticLine = resolveSemanticIssueLine(issue, changedLines);
      if (semanticLine != null) {
        return {
          ...issue,
          line: semanticLine,
        };
      }

      if (
        typeof issue.line !== 'number' ||
        !Number.isFinite(issue.line) ||
        issue.line <= 0
      ) {
        return {
          ...issue,
          line: undefined,
        };
      }

      return {
        ...issue,
        line: normalizeIssueLine(
          issue.line,
          changedLines.map((changedLine) => changedLine.line),
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
export const buildCodeReviewPresentation = (
  review: CodeReview,
): CodeReviewPresentation => ({
  issueRows: review.issues.map((issue, index) => ({
    issue,
    suggestion: review.suggestions[index],
  })),
  unmatchedSuggestions: review.suggestions.slice(review.issues.length),
});

/**
 * Normalize review issues against the diff and derive shared presentation data.
 *
 * @param review - Parsed code review payload
 * @param diff - Raw unified diff used for the review
 * @returns Normalized review plus shared presentation metadata
 */
export const postProcessCodeReview = (
  review: CodeReview,
  diff: string,
): ProcessedCodeReview => {
  const normalizedReview = normalizeReviewIssues(review, diff);

  return {
    review: normalizedReview,
    presentation: buildCodeReviewPresentation(normalizedReview),
  };
};
