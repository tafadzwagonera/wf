import { z } from 'zod';

export const designConformanceDeviationSchema = z.object({
  area: z.string(),
  deviation: z.string(),
});

export const designConformanceResponseSchema = z.object({
  findings: z.array(designConformanceDeviationSchema),
});

export const designConformanceResponseJsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['findings'],
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['area', 'deviation'],
        properties: {
          area: { type: 'string' },
          deviation: { type: 'string' },
        },
      },
    },
  },
} as const;

export const designConformanceFindingSchema = designConformanceDeviationSchema.extend({
  screenshot: z.string(),
});
