import { AiProviderError, AiProviderErrorCategory, AppError, ApprovalError, ERROR_CODE, isAiProviderErrorLike } from './app.error';

describe('AiProviderError category', () => {
  afterEach(() => jest.restoreAllMocks());

  describe('when category is provided', () => {
    it('carries the category on the instance', () => {
      const error = new AiProviderError('msg', null, true, 'parse');
      expect(error.category).toBe('parse');
      expect(error.code).toBe(ERROR_CODE.AI_PROVIDER_ERROR);
      expect(error.recoverable).toBe(true);
    });
  });

  describe('when category is omitted', () => {
    it('has undefined category (backward compat)', () => {
      const error = new AiProviderError('msg');
      expect(error.category).toBeUndefined();
    });
  });

  describe('isAiProviderErrorLike', () => {
    it('detects AiProviderError with category', () => {
      const error = new AiProviderError('msg', null, true, 'parse');
      expect(isAiProviderErrorLike(error)).toBe(true);
    });

    it('detects AiProviderError without category', () => {
      const error = new AiProviderError('msg');
      expect(isAiProviderErrorLike(error)).toBe(true);
    });
  });

  describe('all AiProviderErrorCategory values', () => {
    const categories: AiProviderErrorCategory[] = ['auth', 'api', 'parse', 'truncation', 'stall'];

    for (const category of categories) {
      it(`accepts category '${category}'`, () => {
        const error = new AiProviderError('msg', null, true, category);
        expect(error.category).toBe(category);
      });
    }
  });
});

describe('ApprovalError', () => {
  afterEach(() => jest.restoreAllMocks());

  it('carries the APPROVAL_ERROR code, non-recoverable, and details', () => {
    const error = new ApprovalError('approval denied', { approvalId: 'abc-123' });
    expect(error.code).toBe(ERROR_CODE.APPROVAL_ERROR);
    expect(error.name).toBe('ApprovalError');
    expect(error.recoverable).toBe(false);
    expect(error.details).toEqual({ approvalId: 'abc-123' });
    expect(error).toBeInstanceOf(AppError);
  });
});
