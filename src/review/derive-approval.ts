import type { CodeReview } from '../common/types/review.types';
import { deriveRiskAdjustedSeverity } from './risk-adjusted-severity';

export const deriveApproval = (issues: CodeReview['issues'], modelApproved: boolean): boolean =>
  modelApproved && !issues.some(issue => deriveRiskAdjustedSeverity(issue) === 'error');
