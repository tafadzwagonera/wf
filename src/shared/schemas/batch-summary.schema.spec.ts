import { batchSummarySchema } from './batch-summary.schema';

describe('batchSummarySchema', () => {
  it('accepts a summaries array with file and summary entries', () => {
    const parsed = batchSummarySchema.parse({
      summaries: [{ file: 'src/a.ts', summary: '- tightened the gate' }],
    });
    expect(parsed.summaries).toEqual([{ file: 'src/a.ts', summary: '- tightened the gate' }]);
  });

  it('rejects entries with an empty file or summary', () => {
    expect(batchSummarySchema.safeParse({ summaries: [{ file: '', summary: '- x' }] }).success).toBe(false);
    expect(batchSummarySchema.safeParse({ summaries: [{ file: 'a.ts', summary: '' }] }).success).toBe(false);
  });

  it('rejects payloads without a summaries array', () => {
    expect(batchSummarySchema.safeParse({}).success).toBe(false);
    expect(batchSummarySchema.safeParse('=== FILE: a.ts ===').success).toBe(false);
  });
});
