import type { CodeReview } from '../common/types/review.types';

export const deriveApproval = (issues: CodeReview['issues'], modelApproved: boolean): boolean =>
  modelApproved && !issues.some(issue => issue.severity === 'error');
