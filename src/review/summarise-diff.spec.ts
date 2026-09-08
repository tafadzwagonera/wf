import {
  splitDiffByFile,
  summariseDiff,
  summariseDiffBatched,
  selectSegmentsToSummarise,
  chunkSegmentsByBudget,
  MAX_REVIEW_DIFF_LENGTH,
  ESTIMATED_SUMMARY_LENGTH,
  SUMMARISE_CHUNK_CHAR_BUDGET,
  DiffSegment,
  BatchSummariseFn,
  SummariseDiffOptions,
} from './summarise-diff';

describe('splitDiffByFile', () => {
  it('should split a multi-file diff into per-file segments', () => {
    const diff = [
      'diff --git a/file1.ts b/file1.ts',
      '--- a/file1.ts',
      '+++ b/file1.ts',
      '@@ -1,3 +1,3 @@',
      '-old line',
      '+new line',
      'diff --git a/file2.ts b/file2.ts',
      '--- a/file2.ts',
      '+++ b/file2.ts',
      '@@ -1,2 +1,2 @@',
      '-another old',
      '+another new',
    ].join('\n');

    const segments = splitDiffByFile(diff);

    expect(segments).toHaveLength(2);
    expect(segments[0].file).toBe('file1.ts');
    expect(segments[0].patch).toContain('-old line');
    expect(segments[1].file).toBe('file2.ts');
    expect(segments[1].patch).toContain('-another old');
  });

  it('should return an empty array for an empty diff', () => {
    expect(splitDiffByFile('')).toEqual([]);
  });

  it('should handle a single-file diff', () => {
    const diff = ['diff --git a/only.ts b/only.ts', '--- a/only.ts', '+++ b/only.ts', '@@ -1 +1 @@', '-x', '+y'].join(
      '\n'
    );

    const segments = splitDiffByFile(diff);
    expect(segments).toHaveLength(1);
    expect(segments[0].file).toBe('only.ts');
  });
});

describe('summariseDiff', () => {
  const mockSummarise = jest.fn(async (_patch: string, file: string) => `- Changed ${file}`);

  beforeEach(() => {
    mockSummarise.mockClear();
  });

  it('should return the original diff when total length is within threshold', async () => {
    const segments: DiffSegment[] = [{ file: 'a.ts', patch: 'diff --git a/a.ts b/a.ts\n-old\n+new' }];

    const result = await summariseDiff(segments, 1000, mockSummarise);

    expect(result).toBe(segments[0].patch);
    expect(mockSummarise).not.toHaveBeenCalled();
  });

  it('should summarise the largest segments first when over threshold', async () => {
    const smallPatch = 'diff --git a/small.ts b/small.ts\n+x';
    const largePatch = 'diff --git a/large.ts b/large.ts\n' + 'x'.repeat(200);

    const segments: DiffSegment[] = [
      { file: 'small.ts', patch: smallPatch },
      { file: 'large.ts', patch: largePatch },
    ];

    const result = await summariseDiff(segments, 100, mockSummarise);

    expect(mockSummarise).toHaveBeenCalledWith(largePatch, 'large.ts');
    expect(result).toContain('(summarised)');
    expect(result).toContain('- Changed large.ts');
    // Small patch should be kept verbatim
    expect(result).toContain(smallPatch);
  });

  it('should preserve original segment order in the output', async () => {
    const segmentA: DiffSegment = {
      file: 'a.ts',
      patch: 'diff --git a/a.ts b/a.ts\n' + 'a'.repeat(150),
    };
    const segmentB: DiffSegment = {
      file: 'b.ts',
      patch: 'diff --git a/b.ts b/b.ts\n+small',
    };
    const segmentC: DiffSegment = {
      file: 'c.ts',
      patch: 'diff --git a/c.ts b/c.ts\n' + 'c'.repeat(100),
    };

    const result = await summariseDiff([segmentA, segmentB, segmentC], 80, mockSummarise);

    const aPos = result.indexOf('a.ts');
    const bPos = result.indexOf('b.ts');
    const cPos = result.indexOf('c.ts');

    expect(aPos).toBeLessThan(bPos);
    expect(bPos).toBeLessThan(cPos);
  });

  it('should stop summarising once within threshold', async () => {
    const segments: DiffSegment[] = [
      {
        file: 'big.ts',
        patch: 'diff --git a/big.ts b/big.ts\n' + 'x'.repeat(200),
      },
      {
        file: 'medium.ts',
        patch: 'diff --git a/medium.ts b/medium.ts\n' + 'y'.repeat(50),
      },
    ];

    // Threshold where summarising only the biggest is enough
    await summariseDiff(segments, 100, mockSummarise);

    // The largest should be summarised
    expect(mockSummarise).toHaveBeenCalledWith(expect.stringContaining('big.ts'), 'big.ts');
  });

  it('should keep the raw patch when summarisation fails for a segment', async () => {
    const failingPatch = 'diff --git a/fail.ts b/fail.ts\n' + 'f'.repeat(200);
    const okPatch = 'diff --git a/ok.ts b/ok.ts\n+ok';

    const failingSummarise = jest.fn(async (patch: string, _file: string) => {
      if (patch.includes('fail.ts')) throw new Error('AI unavailable');
      return `- Summarised`;
    });

    const segments: DiffSegment[] = [
      { file: 'fail.ts', patch: failingPatch },
      { file: 'ok.ts', patch: okPatch },
    ];

    const result = await summariseDiff(segments, 100, failingSummarise);

    // Failed segment keeps raw patch verbatim
    expect(result).toContain(failingPatch);
    // Summarisation did not throw — the review still completes
    expect(result).toBeDefined();
  });

  it('reports summarisation failures via onError without aborting the diff', async () => {
    const failure = new Error('AI unavailable');
    const onError = jest.fn();

    const result = await summariseDiff(
      [{ file: 'fail.ts', patch: 'diff --git a/fail.ts b/fail.ts\n' + 'f'.repeat(200) }],
      100,
      async () => {
        throw failure;
      },
      { onError }
    );

    expect(onError).toHaveBeenCalledWith(expect.objectContaining({
      file: 'fail.ts',
      originalLength: expect.any(Number),
      resultLength: expect.any(Number),
      error: failure,
    }));
    expect(result).toContain('diff --git a/fail.ts b/fail.ts');
  });
});

describe('MAX_REVIEW_DIFF_LENGTH', () => {
  it('should be 80,000 characters', () => {
    expect(MAX_REVIEW_DIFF_LENGTH).toBe(80_000);
  });
});

describe('selectSegmentsToSummarise', () => {
  afterEach(() => jest.restoreAllMocks());

  it('selects no segments when total is already at or below threshold', () => {
    const segments: DiffSegment[] = [
      { file: 'a.ts', patch: 'x'.repeat(30_000) },
      { file: 'b.ts', patch: 'y'.repeat(30_000) },
    ];

    const { selected, kept } = selectSegmentsToSummarise(segments, 60_000, ESTIMATED_SUMMARY_LENGTH);

    expect(selected).toHaveLength(0);
    expect(kept).toHaveLength(2);
  });

  it('selects the largest segment first when one replacement is sufficient', () => {
    const segments: DiffSegment[] = [
      { file: 'small.ts', patch: 'x'.repeat(5_000) },
      { file: 'large.ts', patch: 'y'.repeat(50_000) },
      { file: 'medium.ts', patch: 'z'.repeat(20_000) },
    ];

    const { selected, kept } = selectSegmentsToSummarise(segments, 60_000, ESTIMATED_SUMMARY_LENGTH);

    expect(selected.map(s => s.file)).toEqual(['large.ts']);
    expect(kept.map(s => s.file)).toContain('small.ts');
    expect(kept.map(s => s.file)).toContain('medium.ts');
  });

  it('selects multiple segments when one replacement is not enough', () => {
    const segments: DiffSegment[] = [
      { file: 'a.ts', patch: 'a'.repeat(25_000) },
      { file: 'b.ts', patch: 'b'.repeat(25_000) },
      { file: 'c.ts', patch: 'c'.repeat(25_000) },
    ];

    const { selected } = selectSegmentsToSummarise(segments, 30_000, ESTIMATED_SUMMARY_LENGTH);

    expect(selected.length).toBeGreaterThanOrEqual(2);
  });

  it('retains original index on each selected segment', () => {
    const segments: DiffSegment[] = [
      { file: 'a.ts', patch: 'x'.repeat(50_000) },
      { file: 'b.ts', patch: 'y'.repeat(40_000) },
    ];

    const { selected } = selectSegmentsToSummarise(segments, 60_000, ESTIMATED_SUMMARY_LENGTH);

    expect(selected[0]).toHaveProperty('index');
  });

  it('selects exactly the segments needed when total exceeds threshold by one character', () => {
    const threshold = 10_000;
    const segments: DiffSegment[] = [
      { file: 'large.ts', patch: 'x'.repeat(6_000) },
      { file: 'small.ts', patch: 'y'.repeat(4_001) },
    ];

    const { selected, kept } = selectSegmentsToSummarise(segments, threshold, ESTIMATED_SUMMARY_LENGTH);

    expect(selected).toHaveLength(1);
    expect(selected[0].file).toBe('large.ts');
    expect(kept).toHaveLength(1);
    expect(kept[0].file).toBe('small.ts');
  });
});

describe('chunkSegmentsByBudget', () => {
  afterEach(() => jest.restoreAllMocks());

  it('groups segments into chunks that each fit within the budget', () => {
    const segments = [
      { file: 'a.ts', patch: 'a'.repeat(30_000), index: 0 },
      { file: 'b.ts', patch: 'b'.repeat(30_000), index: 1 },
      { file: 'c.ts', patch: 'c'.repeat(30_000), index: 2 },
    ];
    const budget = 60_000;

    const chunks = chunkSegmentsByBudget(segments, budget);

    expect(chunks.length).toBeGreaterThanOrEqual(2);
    for (const chunk of chunks) {
      const chunkSize = chunk.reduce((sum, s) => sum + s.patch.length, 0);
      if (chunk.length > 1) expect(chunkSize).toBeLessThanOrEqual(budget);
    }
  });

  it('puts a segment that exceeds the budget alone in its own chunk', () => {
    const segments = [
      { file: 'giant.ts', patch: 'x'.repeat(70_000), index: 0 },
    ];

    const chunks = chunkSegmentsByBudget(segments, 60_000);

    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toHaveLength(1);
    expect(chunks[0][0].file).toBe('giant.ts');
  });

  it('returns an empty array for an empty input', () => {
    expect(chunkSegmentsByBudget([], 60_000)).toEqual([]);
  });
});

describe('summariseDiffBatched', () => {
  afterEach(() => jest.restoreAllMocks());

  it('returns original diff verbatim when total is within threshold and never calls the batch fn', async () => {
    const segments: DiffSegment[] = [{ file: 'a.ts', patch: 'small patch' }];
    const mockBatch = jest.fn() as jest.MockedFunction<BatchSummariseFn>;

    const result = await summariseDiffBatched(segments, 80_000, mockBatch);

    expect(result).toBe('small patch');
    expect(mockBatch).not.toHaveBeenCalled();
  });

  it('calls the batch fn once per chunk for segments selected for summarisation', async () => {
    const largePatch = 'x'.repeat(40_000);
    const segments: DiffSegment[] = [
      { file: 'a.ts', patch: largePatch },
      { file: 'b.ts', patch: largePatch },
    ];
    const mockBatch = jest.fn().mockResolvedValue(
      new Map([['a.ts', '- changed a'], ['b.ts', '- changed b']])
    ) as jest.MockedFunction<BatchSummariseFn>;

    await summariseDiffBatched(segments, 60_000, mockBatch);

    expect(mockBatch).toHaveBeenCalledTimes(1);
  });

  it('preserves original segment order in output', async () => {
    const segments: DiffSegment[] = [
      { file: 'first.ts', patch: `diff --git a/first.ts b/first.ts\n${'a'.repeat(30_000)}` },
      { file: 'second.ts', patch: `diff --git a/second.ts b/second.ts\n${'b'.repeat(30_000)}` },
    ];
    const mockBatch = jest.fn().mockResolvedValue(
      new Map([['first.ts', '- first summary'], ['second.ts', '- second summary']])
    ) as jest.MockedFunction<BatchSummariseFn>;

    const result = await summariseDiffBatched(segments, 20_000, mockBatch);

    const firstIdx = result.indexOf('first.ts');
    const secondIdx = result.indexOf('second.ts');
    expect(firstIdx).toBeLessThan(secondIdx);
  });

  it('keeps original patches for all segments in a chunk when the batch fn throws and calls onError per segment', async () => {
    const largePatch = 'x'.repeat(20_000);
    const segments: DiffSegment[] = [
      { file: 'a.ts', patch: largePatch },
      { file: 'b.ts', patch: largePatch },
    ];
    const mockBatch = jest.fn().mockRejectedValue(new Error('network fail')) as jest.MockedFunction<BatchSummariseFn>;
    const onError = jest.fn();

    const result = await summariseDiffBatched(segments, 10_000, mockBatch, { onError });

    expect(result).toContain(largePatch);
    expect(onError).toHaveBeenCalledTimes(2);
  });

  it('keeps original patch for a file missing from the batch response and calls onError for it', async () => {
    const largePatch = 'x'.repeat(20_000);
    const segments: DiffSegment[] = [
      { file: 'a.ts', patch: largePatch },
      { file: 'b.ts', patch: largePatch },
    ];
    const mockBatch = jest.fn().mockResolvedValue(
      new Map([['a.ts', '- only a summarised']])
    ) as jest.MockedFunction<BatchSummariseFn>;
    const onError = jest.fn();

    await summariseDiffBatched(segments, 10_000, mockBatch, { onError });

    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0][0]).toMatchObject({ file: 'b.ts' });
  });

  it('treats an empty body as missing and calls onError for that file', async () => {
    const largePatch = 'x'.repeat(20_000);
    const segments: DiffSegment[] = [{ file: 'a.ts', patch: largePatch }];
    const mockBatch = jest.fn().mockResolvedValue(
      new Map([['a.ts', '   ']])
    ) as jest.MockedFunction<BatchSummariseFn>;
    const onError = jest.fn();

    await summariseDiffBatched(segments, 10_000, mockBatch, { onError });

    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ file: 'a.ts' }));
  });

  it('injects the (summarised) header for successfully summarised files', async () => {
    const largePatch = 'x'.repeat(20_000);
    const segments: DiffSegment[] = [{ file: 'a.ts', patch: largePatch }];
    const mockBatch = jest.fn().mockResolvedValue(
      new Map([['a.ts', '- summarised content']])
    ) as jest.MockedFunction<BatchSummariseFn>;

    const result = await summariseDiffBatched(segments, 10_000, mockBatch);

    expect(result).toContain('(summarised)');
    expect(result).toContain('- summarised content');
  });

  it('exports ESTIMATED_SUMMARY_LENGTH as 2000', () => {
    expect(ESTIMATED_SUMMARY_LENGTH).toBe(2_000);
  });

  it('exports SUMMARISE_CHUNK_CHAR_BUDGET as 60000', () => {
    expect(SUMMARISE_CHUNK_CHAR_BUDGET).toBe(60_000);
  });
});
