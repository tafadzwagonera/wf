import { z } from 'zod';
import { codeIssueSchema, codeReviewSchema, reviewTraceStateNodeSchema } from './review.schema';
import { buildSanitisedJsonSchema } from '../../integrations/ai/schema/openai-json-schema';

describe('codeReviewSchema sanitised serialization', () => {
  it('serializes codeReviewSchema with entry-array property names and descriptions', () => {
    const jsonSchema = z.toJSONSchema(codeReviewSchema);
    expect(jsonSchema).toBeDefined();
    const sanitised = buildSanitisedJsonSchema(jsonSchema);
    expect(sanitised).toBeDefined();
    expect(sanitised).toContain('"name"');
    expect(sanitised).toContain('"value"');
    expect(sanitised).toContain('"before"');
    expect(sanitised).toContain('"after"');
    expect(sanitised).toContain('variables observed at this frame');
    expect(sanitised).toContain('values changed since the previous frame');
    expect(sanitised).toContain('frame-aligned tree');
  });

  it('emitted contract preserves z.unknown() entry properties without additionalProperties:false', () => {
    const jsonSchema = z.toJSONSchema(codeReviewSchema);
    const sanitised = buildSanitisedJsonSchema(jsonSchema);
    expect(sanitised).toBeDefined();
    if (sanitised === undefined) {
      throw new Error('sanitised should not be undefined');
    }
    expect(sanitised).toContain('"value"');
    expect(sanitised).toContain('"before"');
    expect(sanitised).toContain('"after"');
    const parsed = JSON.parse(sanitised);
    expect(parsed).toHaveProperty('$defs');
  });
});

describe('reviewTraceStateNodeSchema', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('entry array captured field', () => {
    it('parses entry array format unchanged', () => {
      const result = reviewTraceStateNodeSchema.parse({
        frame: 'Service.method()',
        captured: [
          { name: 'config', value: { debug: true } },
          { name: 'logger', value: 'Logger instance' },
        ],
      });

      expect(result.captured).toEqual([
        { name: 'config', value: { debug: true } },
        { name: 'logger', value: 'Logger instance' },
      ]);
    });

    it('converts legacy record input {a: 1} to entry array [{name: "a", value: 1}]', () => {
      const result = reviewTraceStateNodeSchema.parse({
        frame: 'Service.method()',
        captured: { a: 1 },
      });

      expect(result.captured).toEqual([
        { name: 'a', value: 1 },
      ]);
    });
  });

  describe('entry array changes field', () => {
    it('parses entry array format unchanged', () => {
      const result = reviewTraceStateNodeSchema.parse({
        frame: 'Service.method()',
        changes: [
          { name: 'count', before: 0, after: 5 },
          { name: 'status', before: 'idle', after: 'active' },
        ],
      });

      expect(result.changes).toEqual([
        { name: 'count', before: 0, after: 5 },
        { name: 'status', before: 'idle', after: 'active' },
      ]);
    });

    it('converts legacy record input {a: {before: 1, after: 2}} to entry array', () => {
      const result = reviewTraceStateNodeSchema.parse({
        frame: 'Service.method()',
        changes: { a: { before: 1, after: 2 } },
      });

      expect(result.changes).toEqual([
        { name: 'a', before: 1, after: 2 },
      ]);
    });
  });

  describe('combined entry arrays', () => {
    it('parses captured and changes entry arrays unchanged', () => {
      const result = reviewTraceStateNodeSchema.parse({
        frame: 'Service.method()',
        captured: [{ name: 'var1', value: 'value1' }],
        changes: [{ name: 'var2', before: 'old', after: 'new' }],
      });

      expect(result.captured).toEqual([{ name: 'var1', value: 'value1' }]);
      expect(result.changes).toEqual([{ name: 'var2', before: 'old', after: 'new' }]);
    });

    it('converts legacy record input captured: {a: 1} and changes: {a: {before: 1, after: 2}}', () => {
      const result = reviewTraceStateNodeSchema.parse({
        frame: 'Service.method()',
        captured: { a: 1 },
        changes: { a: { before: 1, after: 2 } },
      });

      expect(result.captured).toEqual([{ name: 'a', value: 1 }]);
      expect(result.changes).toEqual([{ name: 'a', before: 1, after: 2 }]);
    });
  });
});

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

    it('accepts "documentation"', () => {
      const result = codeIssueSchema.parse({ severity: 'warning', message: 'msg', origin: 'documentation' });

      expect(result.origin).toBe('documentation');
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

  describe('risk field', () => {
    it.each([[0], [0.5], [1]])('accepts risk %s', risk => {
      const result = codeIssueSchema.parse({ severity: 'error', message: 'msg', risk });

      expect(result.risk).toBe(risk);
    });

    it('treats missing risk as undefined', () => {
      const result = codeIssueSchema.parse({ severity: 'error', message: 'msg' });

      expect(result.risk).toBeUndefined();
    });

    it('treats null risk as undefined via nullableOptional', () => {
      const result = codeIssueSchema.parse({ severity: 'error', message: 'msg', risk: null });

      expect(result.risk).toBeUndefined();
    });

    it.each([[-0.1], [1.1]])('rejects out-of-range risk %s', risk => {
      expect(() => codeIssueSchema.parse({ severity: 'error', message: 'msg', risk })).toThrow();
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

  describe('coerces nullable strict-output fields', () => {
    it('accepts null for optional review metadata', () => {
      const result = codeReviewSchema.parse({
        summary: 'ok',
        issues: [],
        executionMode: null,
        callStack: [{ frame: 'reviewCode', children: null }],
        stateTransition: null,
        suggestions: [],
        approved: true,
      });

      expect(result.executionMode).toBeUndefined();
      expect(result.callStack?.[0].children).toBeUndefined();
      expect(result.stateTransition).toBeUndefined();
    });
  });
});
