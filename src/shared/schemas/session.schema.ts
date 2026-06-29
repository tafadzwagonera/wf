import { z } from 'zod';
import { wfAiProviderNameSchema, wfBackendModeSchema } from './config.schema';

export const stageConfigFingerprintSchema = z.object({
  provider: wfAiProviderNameSchema,
  backend: wfBackendModeSchema,
});

export const stageRecordSchema = z.object({
  config: stageConfigFingerprintSchema,
  model: z.string(),
  providerSessionId: z.string().nullable(),
  summary: z.string().nullable(),
  startedAt: z.string(),
  completedAt: z.string().nullable(),
});

export const sessionStateSchema = z.object({
  sessionId: z.string(),
  ticketKey: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  completedAt: z.string().nullable(),
  stages: z.record(z.string(), stageRecordSchema),
});
