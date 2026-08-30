import { z } from 'zod';

export const stepStatusSchema = z.enum(['done', 'partially-done', 'not-done', 'not-applicable']);

export const stepAssessmentSchema = z
  .object({
    index: z.number().int().min(0),
    status: stepStatusSchema,
    missing: z.string().optional(),
  })
  .superRefine((v, ctx) => {
    if ((v.status === 'partially-done' || v.status === 'not-done') && !v.missing) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `'missing' is required when status is '${v.status}'`,
        path: ['missing'],
      });
    }
  });

export const stepAssessmentResponseSchema = z.object({
  statuses: z.array(stepAssessmentSchema),
});
