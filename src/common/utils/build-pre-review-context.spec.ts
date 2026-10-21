jest.mock('./run-pre-review-verification', () => ({ runPreReviewVerification: jest.fn() }));
jest.mock('./implement-verification', () => ({ resolveVerificationSummary: jest.fn() }));
jest.mock('./detect-repo-conventions', () => ({
  detectRepoConventions: jest.fn(),
  formatRepoConventionsPromptSection: jest.fn(),
}));

import { runPreReviewVerification } from './run-pre-review-verification';
import { resolveVerificationSummary } from './implement-verification';
import { detectRepoConventions, formatRepoConventionsPromptSection } from './detect-repo-conventions';
import { buildPreReviewContext } from './build-pre-review-context';

const mockRunPreReviewVerification = runPreReviewVerification as jest.MockedFunction<typeof runPreReviewVerification>;
const mockResolveVerificationSummary
  = resolveVerificationSummary as jest.MockedFunction<typeof resolveVerificationSummary>;
const mockDetectRepoConventions = detectRepoConventions as jest.MockedFunction<typeof detectRepoConventions>;
const mockFormatRepoConventionsPromptSection
  = formatRepoConventionsPromptSection as jest.MockedFunction<typeof formatRepoConventionsPromptSection>;

describe('buildPreReviewContext', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockDetectRepoConventions.mockReturnValue({} as ReturnType<typeof detectRepoConventions>);
    mockFormatRepoConventionsPromptSection.mockReturnValue('conventions');
    mockResolveVerificationSummary.mockReturnValue('cached summary');
    mockRunPreReviewVerification.mockResolvedValue({ status: 'passed', source: 'reviewed-diff', checks: [] });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('marks unresolved repositories as not-run', async () => {
    const result = await buildPreReviewContext({ context: 'base', diff: 'diff' });
    expect(result).toEqual({
      context: 'base', verification: expect.objectContaining({ status: 'not-run', source: 'none' }),
    });
  });

  it('passes the exact PR diff to live verification', async () => {
    const result = await buildPreReviewContext({
      context: 'base', diff: 'reviewed diff', repoDir: '/repo', commentRef: 'https://example.test/pr/1', repoCount: 1,
    }, { silent: true });
    expect(mockRunPreReviewVerification).toHaveBeenCalledWith('/repo', {
      diff: 'reviewed diff', silent: true, skipVerification: false,
    });
    expect(result.verification.status).toBe('passed');
  });

  it('verifies a single local repository target', async () => {
    await buildPreReviewContext({ context: 'base', diff: 'diff', repoDir: '/repo', repoCount: 1 });
    expect(mockRunPreReviewVerification).toHaveBeenCalled();
  });

  it('does not verify multi-repository targets and preserves cached context', async () => {
    const result = await buildPreReviewContext({ context: 'base', diff: 'diff', repoDir: '/repo', repoCount: 2 });
    expect(mockRunPreReviewVerification).not.toHaveBeenCalled();
    expect(result.context).toContain('cached summary');
    expect(result.verification).toMatchObject({ status: 'not-run', source: 'cached-summary' });
  });

  it('records --skip-verification as not-run', async () => {
    const result = await buildPreReviewContext({ context: 'base', diff: 'diff', repoDir: '/repo', repoCount: 1 }, { skipVerification: true });
    expect(result.verification).toMatchObject({ status: 'not-run', reason: expect.stringContaining('--skip-verification') });
  });
});
