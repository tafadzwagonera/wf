import { z } from 'zod';

export const nullableOptional = <T extends z.ZodTypeAny>(schema: T) =>
  z.preprocess(v => (v === null ? undefined : v), schema.optional());

export const reviewTraceValueChangeSchema = z.object({
  before: nullableOptional(z.unknown()),
  after: nullableOptional(z.unknown()),
});

export type ReviewTraceCallStackNode = {
  frame: string;
  children?: ReviewTraceCallStackNode[];
};

export const reviewTraceCallStackNodeSchema: z.ZodType<ReviewTraceCallStackNode> = z.object({
  frame: z.string(),
  children: nullableOptional(z.lazy(() => z.array(reviewTraceCallStackNodeSchema))),
});

export type ReviewTraceStateNode = {
  frame: string;
  captured?: Record<string, unknown>;
  changes?: Record<string, { before?: unknown; after?: unknown }>;
  children?: ReviewTraceStateNode[];
};

export const reviewTraceStateNodeSchema: z.ZodType<ReviewTraceStateNode> = z.object({
  frame: z.string(),
  captured: nullableOptional(z.record(z.string(), z.unknown())),
  changes: nullableOptional(z.record(z.string(), reviewTraceValueChangeSchema)),
  children: nullableOptional(z.lazy(() => z.array(reviewTraceStateNodeSchema))),
});

export const reviewTraceStateTransitionSchema = z.object({
  from: nullableOptional(z.string()),
  to: nullableOptional(z.string()),
  steps: nullableOptional(z.array(reviewTraceStateNodeSchema)),
});

export const diffSegmentSchema = z.object({
  file: z.string(),
  patch: z.string(),
});

export const codeIssueSeveritySchema = z.enum(['error', 'warning', 'info']);

export const formatIssueFileLocation = (issue: { file?: string; line?: number; endLine?: number }): string => {
  if (!issue.file) return '';
  const lineRange = issue.line
    ? ':' + issue.line + (issue.endLine && issue.endLine > issue.line ? '-' + issue.endLine : '')
    : '';
  return issue.file + lineRange;
};

export const codeIssueSchema = z.object({
  severity: codeIssueSeveritySchema,
  message: z.string(),
  file: nullableOptional(z.string()),
  line: nullableOptional(z.number()),
  endLine: nullableOptional(z.number()),
  origin: nullableOptional(z.literal('comment-policy')),
  suggestion: nullableOptional(z.string()),
});

export const reviewPresentationIssueRowSchema = z.object({
  issue: codeIssueSchema,
  suggestion: nullableOptional(z.string()),
});

export const codeReviewPresentationSchema = z.object({
  issueRows: z.array(reviewPresentationIssueRowSchema),
  unmatchedSuggestions: z.array(z.string()),
});

export const processedCodeReviewSchema = z.lazy(() =>
  z.object({
    review: codeReviewSchema,
    presentation: codeReviewPresentationSchema,
  })
);

export const codeReviewSchema = z.object({
  summary: z.string(),
  issues: z.array(codeIssueSchema),
  executionMode: nullableOptional(z.enum(['standard', 'agent', 'cli'])),
  repairStrategy: nullableOptional(z.enum(['validation'])),
  traceProvenance: nullableOptional(z.enum(['evidence-based', 'best-effort', 'unavailable'])),
  callStack: nullableOptional(z.array(reviewTraceCallStackNodeSchema)),
  stateTransition: nullableOptional(reviewTraceStateTransitionSchema),
  suggestions: z.array(z.string()),
  approved: z.boolean(),
});
