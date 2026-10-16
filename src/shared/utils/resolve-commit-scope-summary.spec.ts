import { resolveCommitScopeSummary } from './resolve-commit-scope-summary';
import * as reviewModule from './resolve-review-summary';
import * as plansModule from './detect-prior-plans';
import * as descriptionModule from './commit-description-artifact';

describe('resolveCommitScopeSummary', () => {
  let mockReadReviewArtifactSummary: jest.Mock;
  let mockResolveReviewArtifactPath: jest.Mock;
  let mockDetectPriorPlans: jest.Mock;

  beforeEach(() => {
    mockReadReviewArtifactSummary = jest.spyOn(reviewModule, 'readReviewArtifactSummary') as jest.Mock;
    mockResolveReviewArtifactPath = jest.spyOn(reviewModule, 'resolveReviewArtifactPath') as jest.Mock;
    mockDetectPriorPlans = jest.spyOn(plansModule, 'detectPriorPlans') as jest.Mock;
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('returns null and does not call collaborators when ticketKey is null', () => {
    const result = resolveCommitScopeSummary({ repoBaseDir: '/tmp/repo', trackerName: 'jira', ticketKey: null });

    expect(result).toBeNull();
    expect(mockReadReviewArtifactSummary).not.toHaveBeenCalled();
    expect(mockDetectPriorPlans).not.toHaveBeenCalled();
  });

  it('returns null and does not call collaborators when ticketKey is empty string', () => {
    const result = resolveCommitScopeSummary({ repoBaseDir: '/tmp/repo', trackerName: 'jira', ticketKey: '' });

    expect(result).toBeNull();
    expect(mockReadReviewArtifactSummary).not.toHaveBeenCalled();
    expect(mockDetectPriorPlans).not.toHaveBeenCalled();
  });

  it('returns review summary when present and does not call detectPriorPlans', () => {
    const reviewSummary = 'Review summary from artifact';
    mockResolveReviewArtifactPath.mockReturnValueOnce('/path/to/WBP-123-review.md');
    mockReadReviewArtifactSummary.mockReturnValueOnce(reviewSummary);

    const result = resolveCommitScopeSummary({ repoBaseDir: '/tmp/repo', trackerName: 'jira', ticketKey: 'WBP-123' });

    expect(result).toBe(reviewSummary);
    expect(mockReadReviewArtifactSummary).toHaveBeenCalledWith('/path/to/WBP-123-review.md');
    expect(mockDetectPriorPlans).not.toHaveBeenCalled();
  });

  it('returns knownPlanSummary when review is null and knownPlanSummary is provided, without calling detectPriorPlans', () => {
    mockResolveReviewArtifactPath.mockReturnValueOnce('/path/to/WBP-123-review.md');
    mockReadReviewArtifactSummary.mockReturnValueOnce(null);

    const result = resolveCommitScopeSummary({ repoBaseDir: '/tmp/repo', trackerName: 'jira', ticketKey: 'WBP-123', knownPlanSummary: 'Authoritative plan summary for this run' });

    expect(result).toBe('Authoritative plan summary for this run');
    expect(mockDetectPriorPlans).not.toHaveBeenCalled();
  });

  it('prefers review summary over knownPlanSummary when both are present', () => {
    const reviewSummary = 'Review summary from artifact';
    mockResolveReviewArtifactPath.mockReturnValueOnce('/path/to/WBP-123-review.md');
    mockReadReviewArtifactSummary.mockReturnValueOnce(reviewSummary);

    const result = resolveCommitScopeSummary({ repoBaseDir: '/tmp/repo', trackerName: 'jira', ticketKey: 'WBP-123', knownPlanSummary: 'Should not be used' });

    expect(result).toBe(reviewSummary);
    expect(mockDetectPriorPlans).not.toHaveBeenCalled();
  });

  it('falls back to detectPriorPlans when review is null and knownPlanSummary is empty string', () => {
    mockResolveReviewArtifactPath.mockReturnValueOnce('/path/to/WBP-123-review.md');
    mockReadReviewArtifactSummary.mockReturnValueOnce(null);
    mockDetectPriorPlans.mockReturnValueOnce({
      plans: [{ ticketKey: 'WBP-123', summary: 'Plan summary for WBP-123', action: 'fix', estimatedComplexity: 'medium', keywords: [] }],
      repoName: 'my-repo',
    });

    const result = resolveCommitScopeSummary({ repoBaseDir: '/tmp/repo', trackerName: 'jira', ticketKey: 'WBP-123', knownPlanSummary: '' });

    expect(result).toBe('Plan summary for WBP-123');
  });

  it('falls back to detectPriorPlans when review summary is null', () => {
    mockResolveReviewArtifactPath.mockReturnValueOnce('/path/to/WBP-123-review.md');
    mockReadReviewArtifactSummary.mockReturnValueOnce(null);
    mockDetectPriorPlans.mockReturnValueOnce({
      plans: [
        {
          ticketKey: 'WBP-123',
          summary: 'Plan summary for WBP-123',
          action: 'fix',
          estimatedComplexity: 'medium',
          keywords: [],
        },
      ],
      repoName: 'my-repo',
    });

    const result = resolveCommitScopeSummary({ repoBaseDir: '/tmp/repo', trackerName: 'jira', ticketKey: 'WBP-123' });

    expect(result).toBe('Plan summary for WBP-123');
    expect(mockDetectPriorPlans).toHaveBeenCalledWith('repo');
  });

  it('returns null when review is null and no matching plan exists', () => {
    mockResolveReviewArtifactPath.mockReturnValueOnce('/path/to/WBP-123-review.md');
    mockReadReviewArtifactSummary.mockReturnValueOnce(null);
    mockDetectPriorPlans.mockReturnValueOnce({
      plans: [{ ticketKey: 'OTHER-456', summary: 'Plan for other ticket', action: 'fix', estimatedComplexity: 'low', keywords: [] }],
      repoName: 'my-repo',
    });
    expect(resolveCommitScopeSummary({ repoBaseDir: '/tmp/repo', trackerName: 'jira', ticketKey: 'WBP-123' })).toBeNull();
  });

  it('returns null when review is null and plans array is empty', () => {
    mockResolveReviewArtifactPath.mockReturnValueOnce('/path/to/WBP-123-review.md');
    mockReadReviewArtifactSummary.mockReturnValueOnce(null);
    mockDetectPriorPlans.mockReturnValueOnce({ plans: [], repoName: 'my-repo' });
    expect(resolveCommitScopeSummary({ repoBaseDir: '/tmp/repo', trackerName: 'jira', ticketKey: 'WBP-123' })).toBeNull();
  });

  it('returns null when review is null and plan has null ticketKey', () => {
    mockResolveReviewArtifactPath.mockReturnValueOnce('/path/to/WBP-123-review.md');
    mockReadReviewArtifactSummary.mockReturnValueOnce(null);
    mockDetectPriorPlans.mockReturnValueOnce({
      plans: [{ ticketKey: null, summary: 'Plan without ticket key', action: 'fix', estimatedComplexity: 'low', keywords: [] }],
      repoName: 'my-repo',
    });
    expect(resolveCommitScopeSummary({ repoBaseDir: '/tmp/repo', trackerName: 'jira', ticketKey: 'WBP-123' })).toBeNull();
  });

  it('returns null when plan summary is empty string', () => {
    mockResolveReviewArtifactPath.mockReturnValueOnce('/path/to/WBP-123-review.md');
    mockReadReviewArtifactSummary.mockReturnValueOnce(null);
    mockDetectPriorPlans.mockReturnValueOnce({
      plans: [{ ticketKey: 'WBP-123', summary: '', action: 'fix', estimatedComplexity: 'low', keywords: [] }],
      repoName: 'my-repo',
    });
    expect(resolveCommitScopeSummary({ repoBaseDir: '/tmp/repo', trackerName: 'jira', ticketKey: 'WBP-123' })).toBeNull();
  });

  it('returns the first matching plan when multiple exist', () => {
    mockResolveReviewArtifactPath.mockReturnValueOnce('/path/to/WBP-123-review.md');
    mockReadReviewArtifactSummary.mockReturnValueOnce(null);
    mockDetectPriorPlans.mockReturnValueOnce({
      plans: [
        { ticketKey: 'WBP-123', summary: 'First matching plan', action: 'fix', estimatedComplexity: 'medium', keywords: [] },
        { ticketKey: 'WBP-123', summary: 'Second matching plan', action: 'feature', estimatedComplexity: 'low', keywords: [] },
      ],
      repoName: 'my-repo',
    });
    expect(resolveCommitScopeSummary({ repoBaseDir: '/tmp/repo', trackerName: 'jira', ticketKey: 'WBP-123' })).toBe('First matching plan');
  });

  describe('Tier 0 commit description', () => {
    const stagedDiff = 'diff --git a/a.ts b/a.ts\n+change';
    const record = {
      nature: 'fix' as const,
      description: 'Fixes the login redirect.',
      diffSha256: descriptionModule.hashCommitDescriptionDiff(stagedDiff),
    };
    const rendered = 'Fixes the login redirect. (change nature: fix)';
    const baseOptions = { repoBaseDir: '/tmp/repo', trackerName: 'jira', ticketKey: 'WBP-123' };
    let mockReadCommitDescriptionRecord: jest.Mock;

    beforeEach(() => {
      mockReadCommitDescriptionRecord = jest.spyOn(descriptionModule, 'readCommitDescriptionRecord') as jest.Mock;
      mockResolveReviewArtifactPath.mockReturnValue('/path/to/WBP-123-review.md');
    });

    it('returns the rendered description on hash match and wins over the review summary', () => {
      mockReadCommitDescriptionRecord.mockReturnValueOnce(record);
      mockReadReviewArtifactSummary.mockReturnValue('Review summary');

      const result = resolveCommitScopeSummary({ ...baseOptions, stagedDiff });

      expect(result).toBe(rendered);
      expect(mockReadCommitDescriptionRecord).toHaveBeenCalledWith('/path/to/WBP-123-review.commit-description.json');
    });

    it('falls through to the scraped review summary on hash mismatch', () => {
      const staleHash = descriptionModule.hashCommitDescriptionDiff('other');
      mockReadCommitDescriptionRecord.mockReturnValueOnce({ ...record, diffSha256: staleHash });
      mockReadReviewArtifactSummary.mockReturnValueOnce('Review summary');

      const result = resolveCommitScopeSummary({ ...baseOptions, stagedDiff });

      expect(result).toBe('Review summary');
      expect(mockReadCommitDescriptionRecord).toHaveBeenCalledTimes(1);
    });

    it('skips Tier 0 when no staged diff is supplied', () => {
      mockReadReviewArtifactSummary.mockReturnValueOnce('Review summary');

      const result = resolveCommitScopeSummary(baseOptions);

      expect(result).toBe('Review summary');
      expect(mockReadCommitDescriptionRecord).not.toHaveBeenCalled();
    });

    it('reads the reviewArtifactPath override even when ticketKey is null', () => {
      mockReadCommitDescriptionRecord.mockReturnValueOnce(record);

      const result = resolveCommitScopeSummary({
        ...baseOptions, ticketKey: null, stagedDiff, reviewArtifactPath: '/custom/plan-review.md',
      });

      expect(result).toBe(rendered);
      expect(mockReadCommitDescriptionRecord).toHaveBeenCalledWith('/custom/plan-review.commit-description.json');
      expect(mockResolveReviewArtifactPath).not.toHaveBeenCalled();
    });
  });
});
