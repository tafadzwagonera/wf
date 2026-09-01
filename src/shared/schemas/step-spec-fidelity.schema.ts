import { z } from 'zod';

export const stepFidelityFindingSchema = z.object({
  severity: z.enum(['error', 'warning']),
  claim: z.string(),
  deviation: z.string(),
});

export const stepFidelityResponseSchema = z.object({
  findings: z.array(stepFidelityFindingSchema),
});
