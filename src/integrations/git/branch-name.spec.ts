import {
  BRANCH_NAME_PATTERN_DESCRIPTION,
  assertUsableBranchNamePattern,
  findBranchNameViolation,
  isValidBranchName,
  safeBranchNamePattern,
  sanitizeBranchNameInput,
  validateBranchNameInput,
} from './branch-name';
import { ValidationError } from '../../shared/utils/errors';

describe('sanitizeBranchNameInput', () => {
  it('trims surrounding whitespace', () => {
    expect(sanitizeBranchNameInput('  fix/WBP-4015__reviews-feed  ')).toBe('fix/WBP-4015__reviews-feed');
  });

  it('strips a pasted "git checkout -b" prefix', () => {
    expect(sanitizeBranchNameInput('git checkout -b fix/WBP-4015__reviews-feed')).toBe('fix/WBP-4015__reviews-feed');
  });

  it('strips a pasted "git switch -c" prefix', () => {
    expect(sanitizeBranchNameInput('git switch -c fix/WBP-4015__reviews-feed')).toBe('fix/WBP-4015__reviews-feed');
  });

  it('returns a plain branch name unchanged', () => {
    expect(sanitizeBranchNameInput('feature/checkout-totals')).toBe('feature/checkout-totals');
  });
});

describe('isValidBranchName', () => {
  it('accepts a type/KEY__description branch name', () => {
    expect(isValidBranchName('fix/WBP-4015__reviews-feed-tour-name-tag-missing-on-some-review-cards')).toBe(true);
  });

  it('accepts a type/description branch name', () => {
    expect(isValidBranchName('feature/checkout-totals')).toBe(true);
  });

  it('accepts a KEY__description branch name', () => {
    expect(isValidBranchName('WBP-1234__checkout-totals')).toBe(true);
  });

  it('accepts a simple branch name', () => {
    expect(isValidBranchName('checkout-totals')).toBe(true);
  });

  it('rejects a name containing spaces', () => {
    expect(isValidBranchName('git checkout -b fix/WBP-4015__reviews-feed')).toBe(false);
  });

  it('rejects a name with nested slashes', () => {
    expect(isValidBranchName('fix/nested/name')).toBe(false);
  });
});

describe('validateBranchNameInput', () => {
  it('accepts a pasted git checkout command whose branch name is valid', () => {
    expect(validateBranchNameInput('git checkout -b fix/WBP-4015__reviews-feed')).toBe(true);
  });

  it('accepts a valid branch name as-is', () => {
    expect(validateBranchNameInput('fix/WBP-4015__reviews-feed')).toBe(true);
  });

  it('rejects empty input with a reason', () => {
    expect(validateBranchNameInput('   ')).toBe('Branch name cannot be empty');
  });

  it('rejects names with interior spaces with a reason', () => {
    expect(validateBranchNameInput('fix/name with spaces')).toBe('Branch names cannot contain spaces');
  });

  it('explains the accepted patterns for other invalid names', () => {
    expect(validateBranchNameInput('fix/nested/name')).toBe(
      `Branch names should follow pattern: ${BRANCH_NAME_PATTERN_DESCRIPTION}`
    );
  });
});

describe('findBranchNameViolation with a configured pattern', () => {
  const pattern = '^team\\/[a-z-]+$';

  it('accepts a name matching the configured pattern even when defaults would reject it', () => {
    expect(findBranchNameViolation('team/checkout-totals', pattern)).toBeNull();
  });

  it('rejects a name that misses the configured pattern and names that pattern', () => {
    expect(findBranchNameViolation('fix/checkout-totals', pattern)).toBe(
      `Branch names should follow pattern: ${pattern}`
    );
  });

  it('still applies the built-in patterns when no pattern is configured', () => {
    expect(findBranchNameViolation('fix/checkout-totals')).toBeNull();
    expect(findBranchNameViolation('fix/nested/name')).toBe(
      `Branch names should follow pattern: ${BRANCH_NAME_PATTERN_DESCRIPTION}`
    );
  });
});

describe('findBranchNameViolation git ref conventions', () => {
  it('rejects names containing ".." regardless of pattern', () => {
    expect(findBranchNameViolation('fix/a..b', '.+')).toBe('Branch names cannot contain ".."');
  });

  it('rejects names containing "@{"', () => {
    expect(findBranchNameViolation('fix/a@{b}', '.+')).toBe('Branch names cannot contain "@{"');
  });

  it('rejects names containing git-reserved characters', () => {
    expect(findBranchNameViolation('fix/a~b', '.+')).toBe('Branch names cannot contain ~ ^ : ? * [ ] or \\');
  });

  it('rejects names with consecutive slashes', () => {
    expect(findBranchNameViolation('fix//name', '.+')).toBe('Branch names cannot contain consecutive slashes');
  });

  it('rejects names that start or end with "/" or "."', () => {
    expect(findBranchNameViolation('fix/name/', '.+')).toBe('Branch names cannot start or end with "/" or "."');
    expect(findBranchNameViolation('.fix/name', '.+')).toBe('Branch names cannot start or end with "/" or "."');
  });

  it('rejects components ending with ".lock"', () => {
    expect(findBranchNameViolation('fix/name.lock', '.+')).toBe('Branch name components cannot end with ".lock"');
  });
});

describe('safeBranchNamePattern', () => {
  it('returns a compilable pattern unchanged', () => {
    expect(safeBranchNamePattern('^team\\/[a-z-]+$')).toBe('^team\\/[a-z-]+$');
  });

  it('returns undefined for an invalid regex', () => {
    expect(safeBranchNamePattern('[')).toBeUndefined();
  });

  it('returns undefined for missing input', () => {
    expect(safeBranchNamePattern(undefined)).toBeUndefined();
  });
});

describe('assertUsableBranchNamePattern', () => {
  it('accepts a compilable pattern', () => {
    expect(() => assertUsableBranchNamePattern('^team\\/[a-z-]+$', '--branch-name-pattern')).not.toThrow();
  });

  it('accepts missing input', () => {
    expect(() => assertUsableBranchNamePattern(undefined, '--branch-name-pattern')).not.toThrow();
  });

  it('throws a ValidationError naming the source for an invalid regex', () => {
    expect(() => assertUsableBranchNamePattern('[', '--branch-name-pattern')).toThrow(ValidationError);
    expect(() => assertUsableBranchNamePattern('[', '--branch-name-pattern')).toThrow(
      '--branch-name-pattern is not a valid regular expression: ['
    );
  });
});

describe('validateBranchNameInput with a configured pattern', () => {
  it('accepts pasted input whose sanitized name matches the pattern', () => {
    expect(validateBranchNameInput('git checkout -b team/checkout-totals', '^team\\/[a-z-]+$')).toBe(true);
  });

  it('rejects sanitized input that misses the pattern', () => {
    expect(validateBranchNameInput('fix/checkout-totals', '^team\\/[a-z-]+$')).toBe(
      'Branch names should follow pattern: ^team\\/[a-z-]+$'
    );
  });
});
