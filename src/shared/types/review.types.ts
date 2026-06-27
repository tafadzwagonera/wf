import type { z } from 'zod';
import type {
  codeIssueSchema,
  codeIssueSeveritySchema,
  codeReviewPresentationSchema,
  codeReviewSchema,
  diffSegmentSchema,
  processedCodeReviewSchema,
  reviewPresentationIssueRowSchema,
  reviewTraceStateTransitionSchema,
  reviewTraceValueChangeSchema,
} from '../schemas/review.schema';
import type { ReviewTraceCallStackNode, ReviewTraceStateNode } from '../schemas/review.schema';

export type { ReviewTraceCallStackNode, ReviewTraceStateNode };
export type CodeIssue = z.infer<typeof codeIssueSchema>;
export type CodeIssueSeverity = z.infer<typeof codeIssueSeveritySchema>;
export type CodeReview = z.infer<typeof codeReviewSchema>;
export type CodeReviewPresentation = z.infer<typeof codeReviewPresentationSchema>;
export type DiffSegment = z.infer<typeof diffSegmentSchema>;
export type ProcessedCodeReview = z.infer<typeof processedCodeReviewSchema>;
export type ReviewPresentationIssueRow = z.infer<typeof reviewPresentationIssueRowSchema>;
export type ReviewTraceStateTransition = z.infer<typeof reviewTraceStateTransitionSchema>;
export type ReviewTraceValueChange = z.infer<typeof reviewTraceValueChangeSchema>;
