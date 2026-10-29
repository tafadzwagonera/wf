import type { CodeIssue, CodeReview } from '../common/types/review.types';
import { deriveRiskAdjustedSeverity } from './risk-adjusted-severity';

const isDocumentationIssue = (issue: CodeIssue): boolean =>
  issue.origin === 'documentation' || issue.origin === 'comment-policy';

export const deriveApproval = (issues: CodeReview['issues'], modelApproved: boolean): boolean =>
  modelApproved && !issues.some(issue => !isDocumentationIssue(issue) && deriveRiskAdjustedSeverity(issue) === 'error');
