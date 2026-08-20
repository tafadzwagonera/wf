jest.mock('./run-pre-review-verification', () => ({
  runPreReviewVerification: jest.fn(),
}));
jest.mock('./implement-verification', () => ({
  resolveVerificationSummary: jest.fn(),
}));
jest.mock('./detect-repo-conventions', () => ({
  detectRepoConventions: jest.fn(),
  formatRepoConventionsPromptSection: jest.fn(),
}));

import { runPreReviewVerification } from './run-pre-review-verification';
import { resolveVerificationSummary } from './implement-verification';
import { detectRepoConventions, formatRepoConventionsPromptSection } from './detect-repo-conventions';
import { buildPreReviewContext } from './build-pre-review-context';

const mockRunPreReviewVerification
  = runPreReviewVerification as jest.MockedFunction<typeof runPreReviewVerification>;
const mockResolveVerificationSummary
  = resolveVerificationSummary as jest.MockedFunction<typeof resolveVerificationSummary>;
const mockDetectRepoConventions = detectRepoConventions as jest.MockedFunction<typeof detectRepoConventions>;
const mockFormatRepoConventionsPromptSection
  = formatRepoConventionsPromptSection as jest.MockedFunction<typeof formatRepoConventionsPromptSection>;

const BASE = 'base context';

describe('buildPreReviewContext', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockDetectRepoConventions.mockReturnValue({} as ReturnType<typeof detectRepoConventions>);
    mockFormatRepoConventionsPromptSection.mockReturnValue('');
    mockResolveVerificationSummary.mockReturnValue('');
    mockRunPreReviewVerification.mockResolvedValue('');
  });

  it('returns the base context unchanged when repoDir is absent', async () => {
    const result = await buildPreReviewContext({ context: BASE });
    expect(result).toBe(BASE);
    expect(mockRunPreReviewVerification).not.toHaveBeenCalled();
  });

  it('does not call runPreReviewVerification when commentRef is absent', async () => {
    await buildPreReviewContext({ context: BASE, repoDir: '/repo' });
    expect(mockRunPreReviewVerification).not.toHaveBeenCalled();
  });

  it('calls runPreReviewVerification with skipVerification when commentRef is present', async () => {
    await buildPreReviewContext(
      { context: BASE, repoDir: '/repo', commentRef: 'https://example.com/pr/1' },
      { skipVerification: true, silent: true },
    );
    expect(mockRunPreReviewVerification).toHaveBeenCalledWith('/repo', { silent: true, skipVerification: true });
  });

  it('falls back to the cached verification summary when live verification is empty', async () => {
    mockRunPreReviewVerification.mockResolvedValue('');
    mockResolveVerificationSummary.mockReturnValue('cached summary');

    const result = await buildPreReviewContext(
      { context: BASE, repoDir: '/repo', commentRef: 'https://example.com/pr/1' },
      { ticketKey: 'TST-1' },
    );

    expect(result).toContain('cached summary');
  });

  it('prefers the live verification summary over the cached one', async () => {
    mockRunPreReviewVerification.mockResolvedValue('live summary');
    mockResolveVerificationSummary.mockReturnValue('cached summary');

    const result = await buildPreReviewContext(
      { context: BASE, repoDir: '/repo', commentRef: 'https://example.com/pr/1' },
    );

    expect(result).toContain('live summary');
    expect(result).not.toContain('cached summary');
  });

  it('appends the conventions section after the verification summary', async () => {
    mockRunPreReviewVerification.mockResolvedValue('live summary');
    mockFormatRepoConventionsPromptSection.mockReturnValue('conventions section');

    const result = await buildPreReviewContext(
      { context: BASE, repoDir: '/repo', commentRef: 'https://example.com/pr/1' },
    );

    expect(result).toBe(`${BASE}\n\nlive summary\n\nconventions section`);
  });
});
