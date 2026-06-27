import type { z } from 'zod';
import type {
  planVerificationConfigSchema,
  verificationManifestSchema,
  verificationPolicySchema,
  verificationStepSchema,
  verificationWaiverSchema,
} from '../schemas/verification.schema';

export type PlanVerificationConfig = z.infer<typeof planVerificationConfigSchema>;
export type VerificationManifest = z.infer<typeof verificationManifestSchema>;
export type VerificationPolicy = z.infer<typeof verificationPolicySchema>;
export type VerificationStep = z.infer<typeof verificationStepSchema>;
export type VerificationWaiver = z.infer<typeof verificationWaiverSchema>;
