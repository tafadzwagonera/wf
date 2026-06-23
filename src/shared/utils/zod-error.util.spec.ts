import { ZodError } from 'zod';
import { formatFieldNames, formatZodError, isZodErrorLike } from './zod-error.util';

describe('zod-error.util', () => {
  describe('formatFieldNames', () => {
    it('returns empty string for empty array', () => {
      expect(formatFieldNames([])).toBe('');
    });

    it('returns the single field name as-is', () => {
      expect(formatFieldNames(['provider'])).toBe('provider');
    });

    it('joins two field names with "and"', () => {
      expect(formatFieldNames(['provider', 'model'])).toBe('provider and model');
    });

    it('joins three or more field names with commas and "and"', () => {
      expect(formatFieldNames(['provider', 'model', 'apiKey'])).toBe('provider, model and apiKey');
    });
  });

  describe('formatZodError', () => {
    it('formats issues into per-field lines', () => {
      const zodError = new ZodError([
        {
          code: 'invalid_type',
          expected: 'string',
          path: ['ai', 'provider'],
          message: 'Expected string, received number',
        },
      ]);

      const output = formatZodError(zodError);

      expect(output).toContain("Field: 'ai.provider'");
      expect(output).toContain("Code: 'invalid_type'");
      expect(output).toContain('Expected string, received number');
    });

    it('formats multiple issues on separate lines', () => {
      const zodError = new ZodError([
        {
          code: 'invalid_type',
          expected: 'string',
          path: ['provider'],
          message: 'Required',
        },
        {
          code: 'invalid_value',
          values: ['json', 'md'],
          path: ['outputFormat'],
          message: "Invalid enum value. Expected 'json' | 'md', received 'txt'",
        },
      ]);

      const lines = formatZodError(zodError).split('\n');

      expect(lines).toHaveLength(2);
    });
  });

  describe('isZodErrorLike', () => {
    it('returns true for a real ZodError', () => {
      const zodError = new ZodError([]);

      expect(isZodErrorLike(zodError)).toBe(true);
    });

    it('returns true for a duck-typed ZodError', () => {
      const fakeZodError = { name: 'ZodError', issues: [] };

      expect(isZodErrorLike(fakeZodError)).toBe(true);
    });

    it('returns false for null', () => {
      expect(isZodErrorLike(null)).toBe(false);
    });

    it('returns false for a plain Error', () => {
      expect(isZodErrorLike(new Error('test'))).toBe(false);
    });

    it('returns false for an object without issues array', () => {
      expect(isZodErrorLike({ name: 'ZodError' })).toBe(false);
    });
  });
});
