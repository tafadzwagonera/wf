import {
  formatPlanRisk,
  formatPlanRisks,
  normalizePlanRisk,
  normalizePlanRisks,
  parsePlanRiskLine,
} from './plan-risk';

describe('plan-risk', () => {
  describe('formatting risks', () => {
    it.each(['low', 'medium', 'high'] as const)('prefixes severity %s', severity => {
      expect(formatPlanRisk({ description: 'x', severity })).toBe(`[${severity}] x`);
    });

    it('formats undefined risks as empty list', () => {
      expect(formatPlanRisks(undefined)).toEqual([]);
    });
  });

  describe('parsing risk lines', () => {
    it.each(['low', 'medium', 'high'] as const)('parses severity %s', severity => {
      expect(parsePlanRiskLine(`[${severity}] some risk`)).toEqual({ description: 'some risk', severity });
    });

    it('parses case-insensitively', () => {
      expect(parsePlanRiskLine('[High] big')).toEqual({ description: 'big', severity: 'high' });
    });

    it('treats plain strings as medium', () => {
      expect(parsePlanRiskLine('plain')).toEqual({ description: 'plain', severity: 'medium' });
    });

    it('keeps plan-quality prefix in description', () => {
      expect(parsePlanRiskLine('[plan-quality] x')).toEqual({ description: '[plan-quality] x', severity: 'medium' });
    });

    it('round-trips formatted risks', () => {
      const risk = { description: '[plan-quality] x', severity: 'high' as const };
      expect(parsePlanRiskLine(formatPlanRisk(risk))).toEqual(risk);
    });
  });

  describe('normalizing risks', () => {
    it('keeps valid object risks', () => {
      expect(normalizePlanRisk({ description: 'd', severity: 'low' })).toEqual({ description: 'd', severity: 'low' });
    });

    it('coerces invalid severity to medium', () => {
      expect(normalizePlanRisk({ description: 'd', severity: 'urgent' })).toEqual({
        description: 'd',
        severity: 'medium',
      });
    });

    it('parses string risks', () => {
      expect(normalizePlanRisk('[low] d')).toEqual({ description: 'd', severity: 'low' });
    });

    it('stringifies numbers', () => {
      expect(normalizePlanRisk(5)).toEqual({ description: '5', severity: 'medium' });
    });

    it('serialises objects without a description instead of printing [object Object]', () => {
      expect(normalizePlanRisk({ text: 'x' })).toEqual({ description: '{"text":"x"}', severity: 'medium' });
    });

    it('returns undefined for null', () => {
      expect(normalizePlanRisks(null)).toBeUndefined();
    });
  });
});
