import { z } from 'zod';

export const stepFidelityFindingSchema = z.object({
  severity: z.enum(['error', 'warning']),
  claim: z.string(),
  deviation: z.string(),
});

export const stepFidelityResponseSchema = z.object({
  findings: z.array(stepFidelityFindingSchema),
});

export const stepFidelityResponseJsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['findings'],
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['severity', 'claim', 'deviation'],
        properties: {
          severity: { type: 'string', enum: ['error', 'warning'] },
          claim: { type: 'string' },
          deviation: { type: 'string' },
        },
      },
    },
  },
} as const;
