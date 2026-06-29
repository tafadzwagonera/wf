import type { z } from 'zod';
import type { stageConfigFingerprintSchema, stageRecordSchema, sessionStateSchema } from '../schemas/session.schema';

export type StageConfigFingerprint = z.infer<typeof stageConfigFingerprintSchema>;
export type StageRecord = z.infer<typeof stageRecordSchema>;
export type SessionState = z.infer<typeof sessionStateSchema>;

export type SessionValidationResult = {
  canResume: boolean;
  resumableProviderSessionId: string | null;
  priorSummary: string | null;
  warnings: string[];
};
