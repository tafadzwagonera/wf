import { formatPlanRisksSection } from './format-plan-risks-section';

describe('formatPlanRisksSection', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('returns empty string when risks is undefined', () => {
    expect(formatPlanRisksSection(undefined)).toBe('');
  });

  it('returns empty string when risks is null', () => {
    expect(formatPlanRisksSection(null)).toBe('');
  });

  it('returns empty string when risks is an empty array', () => {
    expect(formatPlanRisksSection([])).toBe('');
  });

  it('returns a section with heading and one risk', () => {
    const risks = [{ description: 'Database migration might fail', severity: 'high' }];
    const result = formatPlanRisksSection(risks);
    expect(result).toContain('Known plan risks');
    expect(result).toContain('[high]');
    expect(result).toContain('Database migration might fail');
  });

  it('lists multiple risks up to the cap', () => {
    const risks = Array.from({ length: 5 }, (_, i) => ({
      description: `Risk ${i + 1}`,
      severity: 'medium' as const,
    }));
    const result = formatPlanRisksSection(risks);
    expect(result).toContain('Known plan risks');
    expect(result).toContain('[medium] Risk 1');
    expect(result).toContain('[medium] Risk 5');
  });

  it('truncates risks over the cap and adds omitted count', () => {
    const risks = Array.from({ length: 15 }, (_, i) => ({
      description: `Risk ${i + 1}`,
      severity: 'low' as const,
    }));
    const result = formatPlanRisksSection(risks);
    expect(result).toContain('Known plan risks');
    expect(result).toContain('[low] Risk 1');
    expect(result).toContain('[low] Risk 10');
    expect(result).not.toContain('Risk 11');
    expect(result).toContain('5 more omitted');
    expect(result).toMatch(/5 more omitted\n?$/);
  });
});
