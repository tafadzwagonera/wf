import { z } from 'zod';

export const nullableOptional = <T extends z.ZodTypeAny>(schema: T) =>
  z.preprocess(v => (v === null ? undefined : v), schema.optional());

export const reviewTraceValueChangeSchema = z.object({
  name: z.string(),
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

export type ReviewTraceCapturedEntry = { name: string; value: unknown };
export type ReviewTraceChangeEntry = { name: string; before?: unknown; after?: unknown };

export type ReviewTraceStateNode = {
  frame: string;
  captured?: ReviewTraceCapturedEntry[];
  changes?: ReviewTraceChangeEntry[];
  children?: ReviewTraceStateNode[];
};

export const convertCapturedToEntries = (value: unknown): unknown => {
  if (Array.isArray(value)) return value;
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return Object.entries(value).map(([name, val]) => ({ name, value: val }));
  }
  return value;
};

export const convertChangesToEntries = (value: unknown): unknown => {
  if (Array.isArray(value)) return value;
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return Object.entries(value).map(([name, val]) => {
      if (val && typeof val === 'object' && ('before' in val || 'after' in val)) {
        const objVal = val as Record<string, unknown>;
        return { name, before: objVal.before, after: objVal.after };
      }
      return { name, after: val };
    });
  }
  return value;
};

export const reviewTraceStateNodeSchema: z.ZodType<ReviewTraceStateNode> = z.object({
  frame: z.string(),
  captured: nullableOptional(
    z.preprocess(convertCapturedToEntries,
      z.array(z.object({
        name: z.string(),
        value: z.unknown(),
      }))
    )
  ).describe('variables observed at this frame'),
  changes: nullableOptional(
    z.preprocess(convertChangesToEntries,
      z.array(reviewTraceValueChangeSchema)
    )
  ).describe('values changed since the previous frame'),
  children: nullableOptional(z.lazy(() => z.array(reviewTraceStateNodeSchema)))
    .describe('nested child frames, depth mirrors callStack nesting'),
});

export const reviewTraceStateTransitionSchema = z.object({
  from: nullableOptional(z.string()),
  to: nullableOptional(z.string()),
  steps: nullableOptional(z.array(reviewTraceStateNodeSchema))
    .describe('frame-aligned tree of state mirroring the call stack, not a flat list when the traced path nests'),
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
