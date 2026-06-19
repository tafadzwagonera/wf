import {
  splitDiffByFile,
  summariseDiff,
  MAX_REVIEW_DIFF_LENGTH,
  DiffSegment,
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
    const diff = [
      'diff --git a/only.ts b/only.ts',
      '--- a/only.ts',
      '+++ b/only.ts',
      '@@ -1 +1 @@',
      '-x',
      '+y',
    ].join('\n');

    const segments = splitDiffByFile(diff);
    expect(segments).toHaveLength(1);
    expect(segments[0].file).toBe('only.ts');
  });
});

describe('summariseDiff', () => {
  const mockSummarise = jest.fn(
    async (_patch: string, file: string) => `- Changed ${file}`,
  );

  beforeEach(() => {
    mockSummarise.mockClear();
  });

  it('should return the original diff when total length is within threshold', async () => {
    const segments: DiffSegment[] = [
      { file: 'a.ts', patch: 'diff --git a/a.ts b/a.ts\n-old\n+new' },
    ];

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

    const result = await summariseDiff(
      [segmentA, segmentB, segmentC],
      80,
      mockSummarise,
    );

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
    expect(mockSummarise).toHaveBeenCalledWith(
      expect.stringContaining('big.ts'),
      'big.ts',
    );
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
});

describe('MAX_REVIEW_DIFF_LENGTH', () => {
  it('should be 80,000 characters', () => {
    expect(MAX_REVIEW_DIFF_LENGTH).toBe(80_000);
  });
});
