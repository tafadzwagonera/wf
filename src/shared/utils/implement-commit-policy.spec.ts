import { resolveCommitPolicy, formatCommitPolicyPromptSection } from './implement-commit-policy';

describe('resolveCommitPolicy', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('allows commits for low complexity', () => {
    expect(resolveCommitPolicy('low')).toEqual({ allowsCommit: true, complexity: 'low' });
  });

  it('blocks commits for medium complexity', () => {
    expect(resolveCommitPolicy('medium')).toEqual({ allowsCommit: false, complexity: 'medium' });
  });

  it('blocks commits for high complexity', () => {
    expect(resolveCommitPolicy('high')).toEqual({ allowsCommit: false, complexity: 'high' });
  });

  it('fails closed to high when complexity is undefined', () => {
    expect(resolveCommitPolicy(undefined)).toEqual({ allowsCommit: false, complexity: 'high' });
  });

  it('fails closed to high for an unrecognized complexity value', () => {
    expect(resolveCommitPolicy('trivial')).toEqual({ allowsCommit: false, complexity: 'high' });
  });
});

describe('formatCommitPolicyPromptSection', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('prohibits commits and names the complexity when commits are not allowed', () => {
    const text = formatCommitPolicyPromptSection(resolveCommitPolicy('medium'));
    expect(text).toContain('Do NOT create git commits');
    expect(text).toContain('git commit');
    expect(text).toContain('medium');
  });

  it('does not prohibit commits when commits are allowed', () => {
    const text = formatCommitPolicyPromptSection(resolveCommitPolicy('low'));
    expect(text).not.toContain('Do NOT create git commits');
  });

  it('includes the override clause in both the permissive and prohibitive text', () => {
    const prohibitive = formatCommitPolicyPromptSection(resolveCommitPolicy('high'));
    const permissive = formatCommitPolicyPromptSection(resolveCommitPolicy('low'));
    expect(prohibitive).toContain('overrides any');
    expect(permissive).toContain('overrides any');
  });
});
