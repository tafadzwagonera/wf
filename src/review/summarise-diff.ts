/**
 * Utilities for splitting a unified diff by file and summarising oversized
 * per-file patches so the review prompt stays within context-window limits.
 */

import type { DiffSegment } from '../shared/types/review.types';

export type { DiffSegment } from '../shared/types/review.types';

export const MAX_REVIEW_DIFF_LENGTH = 80_000;

/**
 * Split a unified diff on `diff --git` boundaries into per-file segments.
 *
 * @param diff - Full unified diff string
 * @returns Array of per-file segments
 */
export const splitDiffByFile = (diff: string): DiffSegment[] => {
  const segments: DiffSegment[] = [];
  const parts = diff.split(/(?=^diff --git )/m);

  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed) continue;

    const headerMatch = trimmed.match(/^diff --git a\/(.+?) b\//);
    const file = headerMatch ? headerMatch[1] : 'unknown';
    segments.push({ file, patch: trimmed });
  }

  return segments;
};

/**
 * Summarise oversized per-file patches so the total diff fits within
 * `threshold` characters. Segments that already fit are kept verbatim.
 *
 * @param segments - Per-file diff segments from `splitDiffByFile`
 * @param threshold - Maximum total character length for the reassembled diff
 * @param summarise - AI callback that returns a bullet-point summary for a patch
 * @returns The reassembled diff (possibly with some segments summarised)
 */
export const summariseDiff = async (
  segments: DiffSegment[],
  threshold: number,
  summarise: (patch: string, file: string) => Promise<string>
): Promise<string> => {
  const totalLength = segments.reduce((sum, s) => sum + s.patch.length, 0);

  if (totalLength <= threshold) {
    return segments.map(s => s.patch).join('\n');
  }

  // Work on a mutable copy sorted largest-first by patch size
  const indexed = segments.map((s, i) => ({ ...s, index: i }));
  const sortedBySize = [...indexed].sort((a, b) => b.patch.length - a.patch.length);

  const results: string[] = new Array(segments.length);
  let currentLength = totalLength;

  for (const segment of sortedBySize) {
    if (currentLength <= threshold) {
      results[segment.index] = segment.patch;
      continue;
    }

    let summary: string;
    try {
      summary = await summarise(segment.patch, segment.file);
    } catch {
      // Keep the raw patch when summarisation fails for a single segment
      results[segment.index] = segment.patch;
      continue;
    }
    const summarisedPatch = `diff --git a/${segment.file} b/${segment.file} (summarised)\n${summary}`;

    currentLength -= segment.patch.length;
    currentLength += summarisedPatch.length;
    results[segment.index] = summarisedPatch;
  }

  // Fill any remaining unsummarised segments
  for (let i = 0; i < segments.length; i++) {
    if (!results[i]) {
      results[i] = segments[i].patch;
    }
  }

  return results.join('\n');
};
