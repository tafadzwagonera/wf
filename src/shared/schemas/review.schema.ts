import { z } from 'zod';

export const reviewTraceValueChangeSchema = z.object({
  before: z.unknown().optional(),
  after: z.unknown().optional(),
});

export type ReviewTraceCallStackNode = {
  frame: string;
  children?: ReviewTraceCallStackNode[];
};

export const reviewTraceCallStackNodeSchema: z.ZodType<ReviewTraceCallStackNode> = z.object({
  frame: z.string(),
  children: z.lazy(() => z.array(reviewTraceCallStackNodeSchema)).optional(),
});

export type ReviewTraceStateNode = {
  frame: string;
  captured?: Record<string, unknown>;
  changes?: Record<string, { before?: unknown; after?: unknown }>;
  children?: ReviewTraceStateNode[];
};

export const reviewTraceStateNodeSchema: z.ZodType<ReviewTraceStateNode> = z.object({
  frame: z.string(),
  captured: z.record(z.string(), z.unknown()).optional(),
  changes: z.record(z.string(), reviewTraceValueChangeSchema).optional(),
  children: z.lazy(() => z.array(reviewTraceStateNodeSchema)).optional(),
});

export const reviewTraceStateTransitionSchema = z.object({
  from: z.string().optional(),
  to: z.string().optional(),
  steps: z.array(reviewTraceStateNodeSchema).optional(),
});

export const diffSegmentSchema = z.object({
  file: z.string(),
  patch: z.string(),
});

export const codeIssueSeveritySchema = z.enum(['error', 'warning', 'info']);

export const codeIssueSchema = z.object({
  severity: codeIssueSeveritySchema,
  message: z.string(),
  file: z.string().optional(),
  line: z.number().optional(),
  suggestion: z.string().optional(),
});

export const reviewPresentationIssueRowSchema = z.object({
  issue: codeIssueSchema,
  suggestion: z.string().optional(),
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
  executionMode: z.enum(['standard', 'agent']).optional(),
  traceProvenance: z.enum(['evidence-based', 'best-effort', 'unavailable']).optional(),
  callStack: z.array(reviewTraceCallStackNodeSchema).optional(),
  stateTransition: reviewTraceStateTransitionSchema.optional(),
  suggestions: z.array(z.string()),
  approved: z.boolean(),
});
