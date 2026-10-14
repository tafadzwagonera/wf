import type { CodeReview } from '../shared/types/review.types';
import { deriveApproval } from './derive-approval';

describe('deriveApproval', () => {
  describe('with error severity issues', () => {
    afterEach(() => {
      jest.restoreAllMocks();
    });

    it('returns false when an error severity issue exists, even if model approved is true', () => {
      const issues = [
        { severity: 'error' as const, message: 'Critical issue', file: 'src/test.ts', line: 1 },
      ];
      const result = deriveApproval(issues, true);
      expect(result).toBe(false);
    });

    it('returns false when a mixed list contains an error', () => {
      const issues = [
        { severity: 'warning' as const, message: 'Minor', file: 'src/test.ts', line: 1 },
        { severity: 'error' as const, message: 'Critical', file: 'src/test.ts', line: 2 },
        { severity: 'info' as const, message: 'FYI', file: 'src/test.ts', line: 3 },
      ];
      const result = deriveApproval(issues, true);
      expect(result).toBe(false);
    });
  });

  describe('with non-error severity issues', () => {
    afterEach(() => {
      jest.restoreAllMocks();
    });

    it('returns true when a warning exists and model approved is true', () => {
      const issues = [
        { severity: 'warning' as const, message: 'Minor issue', file: 'src/test.ts', line: 1 },
      ];
      const result = deriveApproval(issues, true);
      expect(result).toBe(true);
    });

    it('returns true when an info exists and model approved is true', () => {
      const issues = [
        { severity: 'info' as const, message: 'FYI', file: 'src/test.ts', line: 1 },
      ];
      const result = deriveApproval(issues, true);
      expect(result).toBe(true);
    });
  });

  describe('model approval value handling', () => {
    afterEach(() => {
      jest.restoreAllMocks();
    });

    it('returns the model value when issues are empty', () => {
      const issues: CodeReview['issues'] = [];
      expect(deriveApproval(issues, true)).toBe(true);
      expect(deriveApproval(issues, false)).toBe(false);
    });

    it('returns false when model approved is false, regardless of warnings', () => {
      const issues = [
        { severity: 'warning' as const, message: 'Minor issue', file: 'src/test.ts', line: 1 },
      ];
      const result = deriveApproval(issues, false);
      expect(result).toBe(false);
    });
  });
});
