import { z } from 'zod';

const commitDescriptionNatures = ['feature', 'fix', 'refactor', 'docs', 'test', 'chore', 'mixed'] as const;

export const commitDescriptionResponseSchema = z.object({
  nature: z.enum(commitDescriptionNatures),
  description: z.string().min(1),
});

export const commitDescriptionResponseJsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['nature', 'description'],
  properties: {
    nature: { type: 'string', enum: [...commitDescriptionNatures] },
    description: { type: 'string', minLength: 1 },
  },
} as const;

export const commitDescriptionRecordSchema = commitDescriptionResponseSchema.extend({
  diffSha256: z.string().regex(/^[a-f0-9]{64}$/),
});
