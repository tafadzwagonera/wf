import { ValidationError } from '../../common/utils/errors';

const GIT_COMMAND_PREFIX_PATTERN = /^git\s+(?:checkout\s+-b|switch\s+-c)\s+/;

const validBranchNamePatterns = [/^[a-z]+\/[\w-]+$/, /^[A-Z]+-\d+__[\w-]+$/, /^[\w-]+$/];

const gitRefConventionRules: ReadonlyArray<{ pattern: RegExp; reason: string }> = [
  { pattern: /\.\./, reason: 'Branch names cannot contain ".."' },
  { pattern: /@\{/, reason: 'Branch names cannot contain "@{"' },
  { pattern: /[~^:?*[\]\\]/, reason: 'Branch names cannot contain ~ ^ : ? * [ ] or \\' },
  { pattern: /\/\//, reason: 'Branch names cannot contain consecutive slashes' },
  { pattern: /(?:^[./])|(?:[./]$)/, reason: 'Branch names cannot start or end with "/" or "."' },
  { pattern: /\.lock(?:\/|$)/, reason: 'Branch name components cannot end with ".lock"' },
];

/**
 * Human-readable summary of the patterns accepted by {@link isValidBranchName},
 * used to keep validation errors in sync with the actual check.
 */
export const BRANCH_NAME_PATTERN_DESCRIPTION = 'feature/name, WBP-1234__feature-name, or simple-name';

/**
 * Normalise raw branch-name input from an interactive prompt: trims whitespace
 * and strips a pasted `git checkout -b` / `git switch -c` command prefix.
 *
 * @param input - Raw string entered at the prompt
 * @returns The bare branch name candidate
 */
export function sanitizeBranchNameInput(input: string): string {
  return input.trim().replace(GIT_COMMAND_PREFIX_PATTERN, '');
}

/**
 * Check whether `name` matches a recognised branch name pattern:
 * `feature/name` (any lowercase type prefix), `WBP-1234__feature-name`,
 * or `simple-name`.
 *
 * @param name - Branch name to validate
 * @returns True when the name matches an accepted pattern
 */
export function isValidBranchName(name: string): boolean {
  return validBranchNamePatterns.some(pattern => pattern.test(name));
}

/**
 * Return `pattern` when it compiles as a regular expression, `undefined` when
 * it is missing or invalid — callers decide whether to warn about the drop.
 *
 * @param pattern - Candidate regex source, e.g. from `git.branchNamePattern`
 * @returns The pattern when usable, otherwise `undefined`
 */
export function safeBranchNamePattern(pattern: string | undefined): string | undefined {
  if (!pattern) return undefined;
  try {
    new RegExp(pattern);
    return pattern;
  } catch {
    return undefined;
  }
}

/**
 * Throw a {@link ValidationError} when `pattern` is present but not a valid
 * regular expression, naming `source` (e.g. `--branch-name-pattern`) so the
 * user knows which input to fix. Missing patterns are fine.
 *
 * @param pattern - Candidate regex source
 * @param source - Where the pattern came from, used in the error message
 */
export function assertUsableBranchNamePattern(pattern: string | undefined, source: string): void {
  if (!pattern || safeBranchNamePattern(pattern)) return;
  throw new ValidationError(`${source} is not a valid regular expression: ${pattern}`);
}

/**
 * Find the first reason `name` is not an acceptable branch name: emptiness,
 * whitespace, git ref-name conventions, then the configured `pattern` (or the
 * built-in patterns when none is given). `pattern` must be a valid regex —
 * pass it through {@link safeBranchNamePattern} first.
 *
 * @param name - Branch name to validate (already sanitised)
 * @param pattern - Optional project convention regex, e.g. `git.branchNamePattern`
 * @returns The violation reason, or `null` when the name is valid
 */
export function findBranchNameViolation(name: string, pattern?: string): string | null {
  if (name.length === 0) return 'Branch name cannot be empty';
  if (/\s/.test(name)) return 'Branch names cannot contain spaces';
  const conventionViolation = gitRefConventionRules.find(rule => rule.pattern.test(name));
  if (conventionViolation) return conventionViolation.reason;
  if (pattern) {
    return new RegExp(pattern).test(name) ? null : `Branch names should follow pattern: ${pattern}`;
  }
  if (!isValidBranchName(name)) return `Branch names should follow pattern: ${BRANCH_NAME_PATTERN_DESCRIPTION}`;
  return null;
}

/**
 * Inquirer-compatible validator for branch-name input: sanitises the input,
 * then returns `true` when valid or a specific reason string when not.
 *
 * @param input - Raw string entered at the prompt
 * @param pattern - Optional project convention regex, e.g. `git.branchNamePattern`
 * @returns `true` when the sanitised name is valid, otherwise the reason it is not
 */
export function validateBranchNameInput(input: string, pattern?: string): true | string {
  const violation = findBranchNameViolation(sanitizeBranchNameInput(input), pattern);
  return violation ?? true;
}
