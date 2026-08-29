/**
 * Utilities for splitting a unified diff by file and summarising oversized
 * per-file patches so the review prompt stays within context-window limits.
 */

import type { DiffSegment } from '../shared/types/review.types';

export type { DiffSegment } from '../shared/types/review.types';

export const MAX_REVIEW_DIFF_LENGTH = 80_000;
export type SummariseDiffFailure = {
  error: unknown;
  file: string;
  originalLength: number;
  resultLength: number;
};

interface SummariseDiffOptions {
  onError?: (failure: SummariseDiffFailure) => void;
}

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

    const headerMatch = /^diff --git a\/(.+?) b\//.exec(trimmed);
    const file = headerMatch ? headerMatch[1] : 'unknown';
    segments.push({ file, patch: trimmed });
  }

  return segments;
};

const summariseSegment = async (
  segment: DiffSegment & { index: number },
  summariseFn: (patch: string, file: string) => Promise<string>,
  options?: SummariseDiffOptions
): Promise<string> => {
  try {
    return buildSummarisedPatch(segment, await summariseFn(segment.patch, segment.file));
  } catch (error) {
    options?.onError?.(buildSummariseFailure(segment, error));
    return segment.patch;
  }
};

const buildSummarisedPatch = (segment: DiffSegment, summary: string): string =>
  `diff --git a/${segment.file} b/${segment.file} (summarised)\n${summary}`;

const buildSummariseFailure = (segment: DiffSegment, error: unknown): SummariseDiffFailure => ({
  file: segment.file,
  error,
  originalLength: segment.patch.length,
  resultLength: segment.patch.length,
});

const indexedSegments = (segments: DiffSegment[]) =>
  [...segments.map((s, i) => ({ ...s, index: i }))].sort((a, b) => b.patch.length - a.patch.length);

const processSegment = async (
  segment: DiffSegment & { index: number }, threshold: number,
  results: string[], currentLength: number,
  summariseFn: (patch: string, file: string) => Promise<string>,
  options?: SummariseDiffOptions
): Promise<number> => {
  if (currentLength <= threshold) {
    results[segment.index] = segment.patch;
    return currentLength;
  }
  const processed = await summariseSegment(segment, summariseFn, options);
  results[segment.index] = processed;
  return currentLength - segment.patch.length + processed.length;
};

const summariseSegments = async (
  segments: DiffSegment[], threshold: number,
  summariseFn: (patch: string, file: string) => Promise<string>,
  options?: SummariseDiffOptions
): Promise<string[]> => {
  const sorted = indexedSegments(segments);
  const results: string[] = new Array(segments.length);
  let currentLength = segments.reduce((sum, s) => sum + s.patch.length, 0);
  for (const segment of sorted) {
    currentLength = await processSegment(segment, threshold, results, currentLength, summariseFn, options);
  }
  return results;
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
  summarise: (patch: string, file: string) => Promise<string>,
  options?: SummariseDiffOptions
): Promise<string> => {
  const totalLength = segments.reduce((sum, s) => sum + s.patch.length, 0);
  if (totalLength <= threshold) return segments.map(s => s.patch).join('\n');
  return (await summariseSegments(segments, threshold, summarise, options)).join('\n');
};
