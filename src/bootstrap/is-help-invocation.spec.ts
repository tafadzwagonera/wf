import { isHelpInvocation } from './is-help-invocation';

describe('isHelpInvocation', () => {
  it('returns true for top-level short help', () => {
    expect(isHelpInvocation(['-h'])).toBe(true);
  });

  it('returns true for command-scoped long help', () => {
    expect(isHelpInvocation(['issue:generate', '--help'])).toBe(true);
  });

  it('returns true when help is combined with repo-scoped options', () => {
    expect(
      isHelpInvocation(['issue:generate', '--repos=service-tourv3', '-h']),
    ).toBe(true);
  });

  it('returns false for normal command invocations', () => {
    expect(isHelpInvocation(['issue:generate', './requirements.md'])).toBe(
      false,
    );
  });
});
