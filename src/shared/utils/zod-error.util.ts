import type { ZodError, ZodIssue } from 'zod';

/**
 * Format a list of field names into a human-readable string.
 *
 * @param fieldNames - Field name strings to join
 * @returns Formatted string ("a", "a and b", "a, b and c")
 */
export const formatFieldNames = (fieldNames: string[]): string => {
  if (fieldNames.length === 0) return '';
  if (fieldNames.length === 1) return fieldNames[0];
  if (fieldNames.length === 2) return `${fieldNames[0]} and ${fieldNames[1]}`;

  return `${fieldNames.slice(0, -1).join(', ')} and ${fieldNames.at(-1)}`;
};

/**
 * Format a ZodError into a human-readable per-field issue listing.
 *
 * @param zodError - Zod validation error
 * @returns Formatted multiline string
 */
export const formatZodError = (zodError: ZodError): string =>
  zodError.issues
    .map(
      (issue: ZodIssue) => `  [Field: '${issue.path.join('.')}', Code: '${issue.code}', Message: "${issue.message}"]`
    )
    .join('\n');

/**
 * Duck-type guard for ZodError instances that may cross module boundaries.
 *
 * @param value - Unknown thrown value
 * @returns True when the value looks like a ZodError
 */
export const isZodErrorLike = (value: unknown): value is ZodError => {
  if (!value || typeof value !== 'object') return false;

  const candidate = value as { name?: unknown; issues?: unknown };
  return candidate.name === 'ZodError' && Array.isArray(candidate.issues);
};
