import { AIError, AIErrorCategory, ERROR_CODE, isAIErrorLike } from './app.error';

describe('AIError category', () => {
  afterEach(() => jest.restoreAllMocks());

  describe('when category is provided', () => {
    it('carries the category on the instance', () => {
      const error = new AIError('msg', null, true, 'parse');
      expect(error.category).toBe('parse');
      expect(error.code).toBe(ERROR_CODE.AI_PROVIDER_ERROR);
      expect(error.recoverable).toBe(true);
    });
  });

  describe('when category is omitted', () => {
    it('has undefined category (backward compat)', () => {
      const error = new AIError('msg');
      expect(error.category).toBeUndefined();
    });
  });

  describe('isAIErrorLike', () => {
    it('detects AIError with category', () => {
      const error = new AIError('msg', null, true, 'parse');
      expect(isAIErrorLike(error)).toBe(true);
    });

    it('detects AIError without category', () => {
      const error = new AIError('msg');
      expect(isAIErrorLike(error)).toBe(true);
    });
  });

  describe('all AIErrorCategory values', () => {
    const categories: AIErrorCategory[] = ['auth', 'api', 'parse', 'truncation', 'stall'];

    for (const category of categories) {
      it(`accepts category '${category}'`, () => {
        const error = new AIError('msg', null, true, category);
        expect(error.category).toBe(category);
      });
    }
  });
});
