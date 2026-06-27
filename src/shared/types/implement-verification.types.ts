import type { z } from 'zod';
import type {
  implementProgressMutationSchema,
  implementProgressSignalSchema,
  implementProgressStreamEventSchema,
  implementProgressVerdictSchema,
  implementProgressVerificationSnapshotSchema,
  implementVerificationRunFileSchema,
  verificationSignalSchema,
} from '../schemas/implement-verification.schema';

export type ImplementProgressMutation = z.infer<typeof implementProgressMutationSchema>;
export type ImplementProgressSignal = z.infer<typeof implementProgressSignalSchema>;
export type ImplementProgressStreamEvent = z.infer<typeof implementProgressStreamEventSchema>;
export type ImplementProgressVerdict = z.infer<typeof implementProgressVerdictSchema>;
export type ImplementProgressVerificationSnapshot = z.infer<typeof implementProgressVerificationSnapshotSchema>;
export type ImplementVerificationRunFile = z.infer<typeof implementVerificationRunFileSchema>;
export type VerificationSignal = z.infer<typeof verificationSignalSchema>;
