import type { z } from 'zod';
import type { stageConfigFingerprintSchema, stageRecordSchema, sessionStateSchema } from '../schemas/session.schema';

export type StageConfigFingerprint = z.infer<typeof stageConfigFingerprintSchema>;
export type StageRecord = z.infer<typeof stageRecordSchema>;
export type SessionState = z.infer<typeof sessionStateSchema>;

export type ProviderSessionCandidate = {
  stage: string;
  provider: StageConfigFingerprint['provider'];
  backend: StageConfigFingerprint['backend'];
  providerSessionId: string;
  recordedAt: string;
};

export type SessionValidationResult = {
  canResume: boolean;
  providerSessionCandidate: ProviderSessionCandidate | null;
  resumableProviderSessionId: string | null;
  priorSummary: string | null;
  warnings: string[];
};
