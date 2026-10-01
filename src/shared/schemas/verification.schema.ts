import { z } from 'zod';

export const verificationPolicySchema = z.enum(['enforced', 'best_effort', 'override']);

export const isValidRegexPattern = (pattern: string): boolean => {
  try {
    new RegExp(pattern);
    return true;
  } catch {
    return false;
  }
};

export const verificationStepSchema = z.object({
  id: z.string(),
  run: z.string(),
  policy: verificationPolicySchema,
  reason: z.string().optional(),
  earlyExitPattern: z.string().min(1).refine(isValidRegexPattern, {
    message: 'must be a valid regular expression',
  }).optional(),
  repo: z.string().optional().describe(
    'Repo name this verification step applies to (must match an entry in affectedRepositories). Required whenever affectedRepositories has more than one entry.'
  ),
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

export const verificationOutcomeSchema = z.object({
  id: z.string(),
  command: z.string(),
  policy: verificationPolicySchema,
  status: z.enum(['passed', 'failed', 'skipped']),
  output: z.string().optional(),
});
