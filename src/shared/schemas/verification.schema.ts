import { z } from 'zod';

export const verificationPolicySchema = z.enum(['enforced', 'best_effort', 'override']);

export const verificationStepSchema = z.object({
  id: z.string(),
  run: z.string(),
  policy: verificationPolicySchema,
  reason: z.string().optional(),
});

export const verificationWaiverSchema = z.object({
  id: z.string(),
  reason: z.string(),
});

export const verificationManifestSchema = z.object({
  version: z.literal(1),
  baseline: z.array(verificationStepSchema),
});

export const planVerificationConfigSchema = z.object({
  targeted: z.array(verificationStepSchema).optional(),
  waivers: z.array(verificationWaiverSchema).optional(),
});
