import { deriveRiskAdjustedSeverity, formatIssueSeverityLabel } from './risk-adjusted-severity';

describe('deriveRiskAdjustedSeverity', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it.each([
    ['error', undefined, 'error'],
    ['error', 1, 'error'],
    ['error', 0.7, 'error'],
    ['error', 0.5, 'warning'],
    ['error', 0.3, 'info'],
    ['error', 0, 'info'],
    ['warning', undefined, 'warning'],
    ['warning', 1, 'warning'],
    ['warning', 0.6, 'warning'],
    ['warning', 0.5, 'info'],
    ['info', undefined, 'info'],
    ['info', 1, 'info'],
    ['info', 0.1, 'info'],
  ] as const)('maps %s with risk %s to %s', (severity, risk, expected) => {
    expect(deriveRiskAdjustedSeverity({ severity, risk })).toBe(expected);
  });
});

describe('formatIssueSeverityLabel', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('returns the bare severity when the issue carries no risk', () => {
    expect(formatIssueSeverityLabel({ severity: 'error' })).toBe('error');
  });

  it('appends the risk when the adjusted severity matches the reported one', () => {
    expect(formatIssueSeverityLabel({ severity: 'error', risk: 0.9 })).toBe('error (risk 0.9)');
  });

  it('shows the demotion when risk lowers the severity', () => {
    expect(formatIssueSeverityLabel({ severity: 'error', risk: 0.5 })).toBe('error → warning (risk 0.5)');
  });
});
