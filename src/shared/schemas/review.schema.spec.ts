import { codeIssueSchema, codeReviewSchema } from './review.schema';

describe('codeIssueSchema', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('accepts all optional fields present', () => {
    it('parses a fully specified issue', () => {
      const result = codeIssueSchema.parse({
        severity: 'error',
        message: 'Something went wrong',
        file: 'src/foo.ts',
        line: 10,
        endLine: 14,
        suggestion: 'Fix it',
      });

      expect(result.severity).toBe('error');
      expect(result.message).toBe('Something went wrong');
      expect(result.file).toBe('src/foo.ts');
      expect(result.line).toBe(10);
      expect(result.endLine).toBe(14);
      expect(result.suggestion).toBe('Fix it');
    });
  });

  describe('accepts optional fields omitted', () => {
    it('leaves optional fields as undefined when absent', () => {
      const result = codeIssueSchema.parse({ severity: 'warning', message: 'Minor issue' });

      expect(result.file).toBeUndefined();
      expect(result.line).toBeUndefined();
      expect(result.suggestion).toBeUndefined();
    });
  });

  describe('coerces null line to undefined', () => {
    it('converts null line to undefined', () => {
      const result = codeIssueSchema.parse({ severity: 'info', message: 'x', line: null });

      expect(result.line).toBeUndefined();
    });
  });

  describe('coerces null file to undefined', () => {
    it('converts null file to undefined', () => {
      const result = codeIssueSchema.parse({ severity: 'info', message: 'x', file: null });

      expect(result.file).toBeUndefined();
    });
  });

  describe('coerces null suggestion to undefined', () => {
    it('converts null suggestion to undefined', () => {
      const result = codeIssueSchema.parse({ severity: 'info', message: 'x', suggestion: null });

      expect(result.suggestion).toBeUndefined();
    });
  });

  describe('accepts endLine range', () => {
    it('parses endLine and returns the value', () => {
      const result = codeIssueSchema.parse({
        severity: 'info',
        message: 'Unused import spans multiple lines.',
        file: 'src/utils.ts',
        line: 10,
        endLine: 14,
      });

      expect(result.endLine).toBe(14);
    });
  });

  describe('coerces null endLine to undefined', () => {
    it('converts null endLine to undefined', () => {
      const result = codeIssueSchema.parse({ severity: 'info', message: 'x', endLine: null });

      expect(result.endLine).toBeUndefined();
    });
  });

  describe('rejects non-numeric line', () => {
    it('throws when line is a string', () => {
      expect(() =>
        codeIssueSchema.parse({ severity: 'error', message: 'x', line: 'not-a-number' })
      ).toThrow();
    });
  });

  describe('origin field', () => {
    it('accepts "comment-policy"', () => {
      const result = codeIssueSchema.parse({ severity: 'warning', message: 'msg', origin: 'comment-policy' });

      expect(result.origin).toBe('comment-policy');
    });

    it('treats missing origin as undefined', () => {
      const result = codeIssueSchema.parse({ severity: 'info', message: 'msg' });

      expect(result.origin).toBeUndefined();
    });

    it('treats null origin as undefined via nullableOptional', () => {
      const result = codeIssueSchema.parse({ severity: 'info', message: 'msg', origin: null });

      expect(result.origin).toBeUndefined();
    });

    it('rejects unknown origin values', () => {
      expect(() => codeIssueSchema.parse({ severity: 'info', message: 'msg', origin: 'other' })).toThrow();
    });
  });

  describe('review repair metadata', () => {
    it('accepts repairStrategy "validation" on a review payload', () => {
      const result = codeReviewSchema.safeParse({
        summary: 'ok',
        issues: [],
        suggestions: [],
        approved: true,
        repairStrategy: 'validation',
      });

      expect(result.success).toBe(true);
    });
  });
});
