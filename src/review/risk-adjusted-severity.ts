import type { CodeIssue, CodeIssueSeverity } from '../common/types/review.types';

const ERROR_SCORE_THRESHOLD = 2;
const WARNING_SCORE_THRESHOLD = 1;

const severityWeights: Record<CodeIssueSeverity, number> = { error: 3, warning: 2, info: 1 };

type RiskAssessedIssue = Pick<CodeIssue, 'severity' | 'risk'>;

/**
 * Derive the severity of an issue weighted by its risk — the probability (0 to 1)
 * that the issue manifests in reality. A missing risk is treated as certain (1),
 * so risk can only lower a severity, never raise it.
 * @param issue Issue carrying the model-reported severity and optional risk
 * @returns Risk-adjusted severity used for verdicts and presentation emphasis
 */
export const deriveRiskAdjustedSeverity = (issue: RiskAssessedIssue): CodeIssueSeverity => {
  const score = severityWeights[issue.severity] * (issue.risk ?? 1);
  if (score > ERROR_SCORE_THRESHOLD) return 'error';
  if (score > WARNING_SCORE_THRESHOLD) return 'warning';
  return 'info';
};

/**
 * Format the severity label for an issue row, surfacing the risk and any
 * risk-driven demotion next to the model-reported severity.
 * @param issue Issue carrying the model-reported severity and optional risk
 * @returns Label such as `error`, `error (risk 0.9)`, or `error → warning (risk 0.5)`
 */
export const formatIssueSeverityLabel = (issue: RiskAssessedIssue): string => {
  if (issue.risk === undefined) return issue.severity;
  const adjusted = deriveRiskAdjustedSeverity(issue);
  return adjusted === issue.severity
    ? `${issue.severity} (risk ${issue.risk})`
    : `${issue.severity} → ${adjusted} (risk ${issue.risk})`;
};
