/**
 * Parse a variadic `--repos` option into a normalized repository list.
 *
 * @param value Raw option value from Commander; either a single repo token or an array of tokens
 * @param previous Previously parsed repo values for repeated parser invocations
 * @returns Trimmed non-empty repository values in input order
 */
export const parseReposOption = (
  value: string | string[],
  previous: string[] = [],
): string[] => {
  const nextValues = (Array.isArray(value) ? value : [value])
    .map((repo) => repo.trim())
    .filter(Boolean);

  return [...previous, ...nextValues];
};
