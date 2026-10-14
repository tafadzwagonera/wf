import type { CodeReview } from '../shared/types/review.types';

export const deriveApproval = (issues: CodeReview['issues'], modelApproved: boolean): boolean =>
  modelApproved && !issues.some(issue => issue.severity === 'error');
