/**
 * Utilities for splitting a unified diff by file and summarising oversized
 * per-file patches so the review prompt stays within context-window limits.
 */

import * as path from 'node:path';
import type { DiffSegment } from '../shared/types/review.types';

export type { DiffSegment } from '../shared/types/review.types';

export const MAX_REVIEW_DIFF_LENGTH = 80_000;
export const ESTIMATED_SUMMARY_LENGTH = 2_000;
export const SUMMARISE_CHUNK_CHAR_BUDGET = 60_000;

export type SummariseDiffFailure = {
  error: unknown;
  file: string;
  originalLength: number;
  resultLength: number;
};

export interface SummariseDiffOptions {
  onError?: (failure: SummariseDiffFailure) => void;
}

export type BatchSummariseFn = (segments: DiffSegment[]) => Promise<ReadonlyMap<string, string>>;

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

type IndexedSegment = DiffSegment & { index: number };

const indexedSegments = (segments: DiffSegment[]): IndexedSegment[] =>
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

const accumulateSegments = (
  sorted: IndexedSegment[], threshold: number, estimatedSummaryLength: number, remainingLength: number
): { selected: IndexedSegment[]; kept: IndexedSegment[] } => {
  const selected: IndexedSegment[] = [];
  const kept: IndexedSegment[] = [];
  for (const segment of sorted) {
    if (remainingLength <= threshold) {
      kept.push(segment);
      continue;
    }
    remainingLength -= segment.patch.length - estimatedSummaryLength;
    selected.push(segment);
  }
  return { selected, kept };
};

export const selectSegmentsToSummarise = (
  segments: DiffSegment[],
  threshold: number,
  estimatedSummaryLength: number
): { selected: IndexedSegment[]; kept: IndexedSegment[] } => accumulateSegments(
  indexedSegments(segments),
  threshold,
  estimatedSummaryLength,
  segments.reduce((sum, s) => sum + s.patch.length, 0)
);

export const chunkSegmentsByBudget = (segments: IndexedSegment[], budget: number): IndexedSegment[][] => {
  const chunks: IndexedSegment[][] = [];
  let current: IndexedSegment[] = [];
  let currentSize = 0;
  for (const segment of segments) {
    if (current.length > 0 && currentSize + segment.patch.length > budget) {
      chunks.push(current);
      [current, currentSize] = [[], 0];
    }
    current.push(segment);
    currentSize += segment.patch.length;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
};

const applyBatchSummaries = (
  chunk: IndexedSegment[], summaryMap: ReadonlyMap<string, string>, results: string[], onError: SummariseDiffOptions['onError']
): void => {
  for (const segment of chunk) {
    const summary = summaryMap.get(path.normalize(segment.file));
    if (!summary?.trim()) {
      onError?.(buildSummariseFailure(segment, new Error('file missing from batch summary response')));
      continue;
    }
    results[segment.index] = buildSummarisedPatch(segment, summary);
  }
};

const processBatchChunk = async (
  chunk: IndexedSegment[], results: string[], summariseBatch: BatchSummariseFn, onError: SummariseDiffOptions['onError']
): Promise<void> => {
  try {
    applyBatchSummaries(chunk, await summariseBatch(chunk), results, onError);
  } catch (error) {
    for (const segment of chunk) onError?.(buildSummariseFailure(segment, error));
  }
};

export const summariseDiffBatched = async (
  segments: DiffSegment[],
  threshold: number,
  summariseBatch: BatchSummariseFn,
  options?: SummariseDiffOptions
): Promise<string> => {
  const totalLength = segments.reduce((sum, s) => sum + s.patch.length, 0);
  if (totalLength <= threshold) return segments.map(s => s.patch).join('\n');
  const { selected } = selectSegmentsToSummarise(segments, threshold, ESTIMATED_SUMMARY_LENGTH);
  const chunks = chunkSegmentsByBudget(selected, SUMMARISE_CHUNK_CHAR_BUDGET);
  const results: string[] = segments.map(s => s.patch);
  for (const chunk of chunks) await processBatchChunk(chunk, results, summariseBatch, options?.onError);
  return results.join('\n');
};
