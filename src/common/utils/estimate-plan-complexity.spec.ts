import { estimatePlanComplexity } from './estimate-plan-complexity';

const files = (n: number) => Array.from({ length: n }, (_, i) => `f${i}.ts`);
const steps = (n: number) => Array.from({ length: n }, (_, i) => ({ description: `s${i}` }));

describe('estimatePlanComplexity', () => {
  describe('size tier', () => {
    it('scores an empty plan low', () => {
      expect(estimatePlanComplexity({ steps: [] })).toBe('low');
    });

    it('scores 2 files and 5 steps low', () => {
      expect(estimatePlanComplexity({ steps: steps(5), affectedFiles: files(2) })).toBe('low');
    });

    it('scores 3 files medium', () => {
      expect(estimatePlanComplexity({ steps: steps(1), affectedFiles: files(3) })).toBe('medium');
    });

    it('scores 6 steps medium', () => {
      expect(estimatePlanComplexity({ steps: steps(6), affectedFiles: files(1) })).toBe('medium');
    });

    it('scores 11 files high', () => {
      expect(estimatePlanComplexity({ steps: steps(1), affectedFiles: files(11) })).toBe('high');
    });

    it('scores 10 files and 20 steps medium', () => {
      expect(estimatePlanComplexity({ steps: steps(20), affectedFiles: files(10) })).toBe('medium');
    });

    it('scores non-empty phases high', () => {
      expect(estimatePlanComplexity({ steps: [], phases: [{ label: 'p', stepIndices: [] }] })).toBe('high');
    });

    it('scores non-empty newRepositories high', () => {
      expect(estimatePlanComplexity({ steps: [], newRepositories: ['r'] })).toBe('high');
    });

    it('does not score empty phases or newRepositories high', () => {
      expect(estimatePlanComplexity({ steps: [], phases: [], newRepositories: [] })).toBe('low');
    });

    it('counts glob and object entries by length', () => {
      const affectedFiles = ['src/**/*.ts', { filePath: 'a.ts', status: 'found' as const }, 'b.ts'];
      expect(estimatePlanComplexity({ steps: [], affectedFiles })).toBe('medium');
    });
  });

  describe('risk tier', () => {
    it('lifts low to medium with a medium risk', () => {
      expect(estimatePlanComplexity({ steps: [], risks: [{ description: 'r', severity: 'medium' }] })).toBe('medium');
    });

    it('scores a high risk high', () => {
      expect(estimatePlanComplexity({ steps: [], risks: [{ description: 'r', severity: 'high' }] })).toBe('high');
    });

    it('never de-escalates size-high', () => {
      const risks = [{ description: 'r', severity: 'low' as const }];
      expect(estimatePlanComplexity({ steps: [], affectedFiles: files(11), risks })).toBe('high');
    });

    it('treats undefined and empty risks as low', () => {
      expect(estimatePlanComplexity({ steps: [], risks: undefined })).toBe('low');
      expect(estimatePlanComplexity({ steps: [], risks: [] })).toBe('low');
    });
  });
});
