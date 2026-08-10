import { z } from 'zod';
import { wfAiProviderNameSchema, wfBackendModeSchema } from './config.schema';

export const stageConfigFingerprintSchema = z.object({
  provider: wfAiProviderNameSchema,
  backend: wfBackendModeSchema,
});

export const stageRecordSchema = z.object({
  config: stageConfigFingerprintSchema,
  model: z.string(),
  providerSessionId: z.string().nullable().default(null),
  summary: z.string().nullable().default(null),
  startedAt: z.string(),
  completedAt: z.string().nullable().default(null),
});

export const sessionStateSchema = z.object({
  sessionId: z.string(),
  ticketKey: z.string(),
  toStage: z.string().nullable().default(null),
  action: z.string().nullable().default(null),
  sourceType: z.enum(['ticket', 'custom']).nullable().default(null),
  customPlanRef: z.string().nullable().default(null),
  createdAt: z.string(),
  updatedAt: z.string(),
  completedAt: z.string().nullable(),
  stages: z.record(z.string(), stageRecordSchema),
});
