import { AiProviderError, AiProviderErrorCategory, ERROR_CODE, isAiProviderErrorLike } from './app.error';

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
