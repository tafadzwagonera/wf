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

export const stepAssessmentResponseJsonSchema = {
  type: 'object',
  properties: {
    statuses: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          index: { type: 'integer', minimum: 0 },
          status: { type: 'string', enum: ['done', 'partially-done', 'not-done', 'not-applicable'] },
          missing: { type: 'string' },
        },
        required: ['index', 'status'],
        additionalProperties: false,
      },
    },
  },
  required: ['statuses'],
  additionalProperties: false,
} as const;
